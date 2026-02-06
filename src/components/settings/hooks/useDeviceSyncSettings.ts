import { useCallback, useEffect, useRef, useState } from "react";
import { encodeBase64Url } from "../../../security/base64url";
import { getOrCreateDeviceId } from "../../../security/deviceRole";
import {
  createSyncCode,
  onPairingRequest,
  onPairingResult,
  approvePairingRequest,
  rejectPairingRequest,
  submitSyncCode,
  startRendezvousPairingAsHost,
  startRendezvousPairingAsGuest,
  type PairingRequest,
  type PairingResult,
  type SyncCodeState,
  type RendezvousPairingSession,
  type RendezvousPairingStatus,
} from "../../../devices/devicePairing";
import {
  createDeviceAddedEvent,
  storeDeviceApproval,
  verifyDeviceAddedEvent,
} from "../../../devices/deviceApprovals";
import {
  startDeviceSyncAsApprover,
  startDeviceSyncAsInitiator,
} from "../../../devices/deviceSync";
import { resolveInternalRendezvousConfig } from "../../../net/rendezvousConfig";
import { getDhPublicKey, getIdentityPublicKey } from "../../../security/identityKeys";
import type { DeviceSyncTransportPolicy } from "../../../preferences";

type Translate = (ko: string, en: string) => string;
type LinkStatus = "idle" | "pending" | "approved" | "rejected" | "error";

type UseDeviceSyncSettingsArgs = {
  t: Translate;
  view: string;
  open: boolean;
  deviceSyncTransportPolicy: DeviceSyncTransportPolicy;
  onChangeDeviceSyncTransportPolicy: (value: DeviceSyncTransportPolicy) => Promise<void>;
  addToast: (toast: { message: string }) => void;
};

const formatTimestamp = (value: number) => {
  if (!Number.isFinite(value)) return "-";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return "-";
  }
};

const formatCountdown = (valueMs: number) => {
  const totalSeconds = Math.max(0, Math.ceil(valueMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
};

export const useDeviceSyncSettings = ({
  t,
  view,
  open,
  deviceSyncTransportPolicy,
  onChangeDeviceSyncTransportPolicy,
  addToast,
}: UseDeviceSyncSettingsArgs) => {
  const [syncCodeState, setSyncCodeState] = useState<SyncCodeState | null>(null);
  const [syncCodeNow, setSyncCodeNow] = useState(Date.now());
  const [pairingRequest, setPairingRequest] = useState<PairingRequest | null>(null);
  const [pairingRequestError, setPairingRequestError] = useState("");
  const [pairingRequestBusy, setPairingRequestBusy] = useState(false);
  const [linkCodeDraft, setLinkCodeDraft] = useState("");
  const [linkRequestId, setLinkRequestId] = useState<string | null>(null);
  const [linkStatus, setLinkStatus] = useState<LinkStatus>("idle");
  const [linkMessage, setLinkMessage] = useState("");
  const [linkBusy, setLinkBusy] = useState(false);
  const linkTimeoutRef = useRef<number | null>(null);

  const [hostRendezvousStatus, setHostRendezvousStatus] =
    useState<RendezvousPairingStatus>("idle");
  const [guestRendezvousStatus, setGuestRendezvousStatus] =
    useState<RendezvousPairingStatus>("idle");
  const hostRendezvousRef = useRef<RendezvousPairingSession | null>(null);
  const guestRendezvousRef = useRef<RendezvousPairingSession | null>(null);
  const hostRendezvousUnsubRef = useRef<(() => void) | null>(null);
  const guestRendezvousUnsubRef = useRef<(() => void) | null>(null);

  const stopHostRendezvous = useCallback(() => {
    hostRendezvousUnsubRef.current?.();
    hostRendezvousUnsubRef.current = null;
    if (hostRendezvousRef.current) {
      hostRendezvousRef.current.stop();
      hostRendezvousRef.current = null;
    }
    setHostRendezvousStatus("idle");
  }, []);

  const stopGuestRendezvous = useCallback(() => {
    guestRendezvousUnsubRef.current?.();
    guestRendezvousUnsubRef.current = null;
    if (guestRendezvousRef.current) {
      guestRendezvousRef.current.stop();
      guestRendezvousRef.current = null;
    }
    setGuestRendezvousStatus("idle");
  }, []);

  const startHostRendezvous = useCallback(
    (syncCode: string) => {
      stopHostRendezvous();
      const session = startRendezvousPairingAsHost({
        syncCode,
        deviceId: getOrCreateDeviceId(),
        rendezvousConfig: resolveInternalRendezvousConfig(),
      });
      hostRendezvousRef.current = session;
      setHostRendezvousStatus(session.getStatus());
      hostRendezvousUnsubRef.current = session.onStatus((status) => {
        setHostRendezvousStatus(status);
      });
    },
    [stopHostRendezvous]
  );

  const startGuestRendezvous = useCallback(
    (syncCode: string) => {
      stopGuestRendezvous();
      const session = startRendezvousPairingAsGuest({
        syncCode,
        deviceId: getOrCreateDeviceId(),
        rendezvousConfig: resolveInternalRendezvousConfig(),
      });
      guestRendezvousRef.current = session;
      setGuestRendezvousStatus(session.getStatus());
      guestRendezvousUnsubRef.current = session.onStatus((status) => {
        setGuestRendezvousStatus(status);
      });
    },
    [stopGuestRendezvous]
  );

  const handleApprovedResult = useCallback(
    async (result: PairingResult) => {
      setLinkBusy(false);
      const event = result.event;
      if (!event) {
        setLinkStatus("error");
        setLinkMessage(t("승인 이벤트를 받지 못했습니다.", "Missing approval event."));
        return;
      }
      try {
        const localDeviceId = getOrCreateDeviceId();
        if (event.deviceId !== localDeviceId) {
          setLinkStatus("error");
          setLinkMessage(t("승인 대상이 이 기기가 아닙니다.", "Approval does not match this device."));
          return;
        }
        const [identityPub, dhPub] = await Promise.all([getIdentityPublicKey(), getDhPublicKey()]);
        const localIdentity = encodeBase64Url(identityPub);
        const localDh = encodeBase64Url(dhPub);
        if (event.identityPub !== localIdentity || event.dhPub !== localDh) {
          setLinkStatus("error");
          setLinkMessage(t("기기 키가 일치하지 않습니다.", "Device keys do not match."));
          return;
        }
        if (!event.approvedBy || !event.approverIdentityPub || !event.approverDhPub) {
          setLinkStatus("error");
          setLinkMessage(t("승인 정보가 누락되었습니다.", "Approval data is missing."));
          return;
        }
        const verified = await verifyDeviceAddedEvent(event);
        if (!verified) {
          setLinkStatus("error");
          setLinkMessage(
            t("승인 서명 검증에 실패했습니다.", "Approval signature verification failed.")
          );
          return;
        }
        const stored = await storeDeviceApproval(event);
        if (!stored) {
          setLinkStatus("error");
          setLinkMessage(t("승인 정보를 저장하지 못했습니다.", "Failed to store approval."));
          return;
        }
        await startDeviceSyncAsInitiator({
          deviceId: event.approvedBy,
          identityPub: event.approverIdentityPub,
          dhPub: event.approverDhPub,
          syncTransportPolicy: deviceSyncTransportPolicy,
        });
        setLinkStatus("approved");
        setLinkMessage(t("승인이 완료되었습니다. 동기화를 시작합니다.", "Approved. Starting sync."));
        stopGuestRendezvous();
      } catch (error) {
        console.error("Failed to process approval result", error);
        setLinkStatus("error");
        setLinkMessage(t("승인 처리에 실패했습니다.", "Failed to process approval."));
      }
    },
    [deviceSyncTransportPolicy, stopGuestRendezvous, t]
  );

  useEffect(() => {
    if (view !== "devices") return;
    const unsubscribeRequests = onPairingRequest((request) => {
      setPairingRequestError("");
      setPairingRequest(request);
      setSyncCodeState((prev) => {
        if (!prev || prev.code !== request.code) return prev;
        return { ...prev, used: true };
      });
    });
    const unsubscribeResults = onPairingResult((result) => {
      if (!linkRequestId || result.requestId !== linkRequestId) return;
      if (linkTimeoutRef.current) {
        window.clearTimeout(linkTimeoutRef.current);
        linkTimeoutRef.current = null;
      }
      if (result.status === "approved") {
        void handleApprovedResult(result);
        return;
      }
      stopGuestRendezvous();
      setLinkBusy(false);
      if (result.status === "rejected") {
        setLinkStatus("rejected");
        setLinkMessage(result.message || t("요청이 거절되었습니다.", "Request rejected."));
        return;
      }
      setLinkStatus("error");
      setLinkMessage(result.message || t("연결에 실패했습니다.", "Connection failed."));
    });
    return () => {
      unsubscribeRequests();
      unsubscribeResults();
      if (linkTimeoutRef.current) {
        window.clearTimeout(linkTimeoutRef.current);
        linkTimeoutRef.current = null;
      }
      stopGuestRendezvous();
    };
  }, [handleApprovedResult, linkRequestId, stopGuestRendezvous, t, view]);

  useEffect(() => {
    if (!syncCodeState) return;
    const timer = window.setInterval(() => setSyncCodeNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [syncCodeState]);

  useEffect(() => {
    if (!open) {
      stopHostRendezvous();
      stopGuestRendezvous();
    }
    return () => {
      stopHostRendezvous();
      stopGuestRendezvous();
    };
  }, [open, stopGuestRendezvous, stopHostRendezvous]);

  const syncCodeRemainingMs = syncCodeState
    ? Math.max(0, syncCodeState.expiresAt - syncCodeNow)
    : 0;
  const syncCodeExpired = Boolean(syncCodeState && syncCodeRemainingMs <= 0);

  useEffect(() => {
    if (!syncCodeState || syncCodeExpired) {
      stopHostRendezvous();
    }
  }, [stopHostRendezvous, syncCodeExpired, syncCodeState]);

  const handleGenerateSyncCode = useCallback(() => {
    try {
      const next = createSyncCode();
      setSyncCodeState(next);
      setSyncCodeNow(Date.now());
      setPairingRequest(null);
      setPairingRequestError("");
      startHostRendezvous(next.code);
    } catch (error) {
      console.error("Failed to generate sync code", error);
      addToast({ message: t("코드 생성에 실패했습니다.", "Failed to generate code.") });
    }
  }, [addToast, startHostRendezvous, t]);

  const handleCopySyncCode = useCallback(async () => {
    if (!syncCodeState?.code) return;
    try {
      if (!navigator.clipboard) throw new Error("Clipboard not available");
      await navigator.clipboard.writeText(syncCodeState.code);
      addToast({ message: t("코드를 복사했습니다.", "Code copied.") });
    } catch (error) {
      console.error("Failed to copy sync code", error);
      addToast({ message: t("코드 복사에 실패했습니다.", "Failed to copy code.") });
    }
  }, [addToast, syncCodeState?.code, t]);

  const handleApproveRequest = useCallback(async () => {
    if (!pairingRequest) return;
    setPairingRequestBusy(true);
    setPairingRequestError("");
    try {
      const event = await createDeviceAddedEvent({
        deviceId: pairingRequest.deviceId,
        identityPub: pairingRequest.identityPub,
        dhPub: pairingRequest.dhPub,
      });
      const stored = await storeDeviceApproval(event);
      if (!stored) {
        setPairingRequestError(t("승인 정보를 저장하지 못했습니다.", "Failed to store approval."));
        return;
      }
      approvePairingRequest(pairingRequest.requestId, event);
      await startDeviceSyncAsApprover({
        deviceId: pairingRequest.deviceId,
        identityPub: pairingRequest.identityPub,
        dhPub: pairingRequest.dhPub,
        syncTransportPolicy: deviceSyncTransportPolicy,
      });
      setPairingRequest(null);
      addToast({ message: t("새 기기를 승인했습니다.", "New device approved.") });
    } catch (error) {
      console.error("Failed to approve device", error);
      setPairingRequestError(t("승인 처리에 실패했습니다.", "Approval failed."));
    } finally {
      setPairingRequestBusy(false);
    }
  }, [addToast, deviceSyncTransportPolicy, pairingRequest, t]);

  const handleRejectRequest = useCallback(() => {
    if (!pairingRequest) return;
    rejectPairingRequest(pairingRequest.requestId, t("요청이 거절되었습니다.", "Request rejected."));
    setPairingRequest(null);
    addToast({ message: t("요청을 거절했습니다.", "Request rejected.") });
  }, [addToast, pairingRequest, t]);

  const handleSubmitLink = useCallback(async () => {
    const code = linkCodeDraft.trim();
    if (!code) {
      setLinkStatus("error");
      setLinkMessage(t("연결 코드를 입력해 주세요.", "Enter a sync code."));
      return;
    }
    setLinkBusy(true);
    setLinkStatus("pending");
    setLinkMessage(t("승인을 기다리는 중...", "Waiting for approval..."));
    try {
      const [identityPub, dhPub] = await Promise.all([getIdentityPublicKey(), getDhPublicKey()]);
      const requestId = submitSyncCode({
        code,
        deviceId: getOrCreateDeviceId(),
        identityPub: encodeBase64Url(identityPub),
        dhPub: encodeBase64Url(dhPub),
      });
      setLinkRequestId(requestId);
      startGuestRendezvous(code);
      if (linkTimeoutRef.current) {
        window.clearTimeout(linkTimeoutRef.current);
      }
      linkTimeoutRef.current = window.setTimeout(() => {
        stopGuestRendezvous();
        setLinkBusy(false);
        setLinkStatus("error");
        setLinkMessage(
          t(
            "기존 기기의 응답이 없습니다. 온라인 상태를 확인하세요.",
            "No response from the existing device. Check it is online."
          )
        );
      }, 30_000);
    } catch (error) {
      console.error("Failed to submit sync code", error);
      stopGuestRendezvous();
      setLinkBusy(false);
      setLinkStatus("error");
      setLinkMessage(t("연결 요청에 실패했습니다.", "Failed to request pairing."));
    }
  }, [linkCodeDraft, startGuestRendezvous, stopGuestRendezvous, t]);

  const handleDeviceSyncPolicyChange = useCallback(
    async (transportPolicy: DeviceSyncTransportPolicy) => {
      if (transportPolicy === deviceSyncTransportPolicy) return;
      await onChangeDeviceSyncTransportPolicy(transportPolicy);
    },
    [deviceSyncTransportPolicy, onChangeDeviceSyncTransportPolicy]
  );

  const linkStatusClass =
    linkStatus === "approved"
      ? "text-emerald-300"
      : linkStatus === "pending"
        ? "text-nkc-muted"
        : "text-red-300";

  return {
    syncCodeState,
    syncCodeExpired,
    syncCodeRemainingMs,
    formatCountdown,
    pairingRequest,
    formatTimestamp,
    pairingRequestBusy,
    pairingRequestError,
    handleGenerateSyncCode,
    handleCopySyncCode,
    handleApproveRequest,
    handleRejectRequest,
    linkCodeDraft,
    setLinkCodeDraft,
    linkStatus,
    setLinkStatus,
    setLinkMessage,
    linkBusy,
    linkStatusClass,
    linkMessage,
    handleSubmitLink,
    hostRendezvousStatus,
    guestRendezvousStatus,
    handleDeviceSyncPolicyChange,
  };
};
