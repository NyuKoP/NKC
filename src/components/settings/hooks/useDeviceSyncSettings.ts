import { useCallback, useEffect, useRef, useState } from "react";
import { encodeBase64Url } from "../../../security/base64url";
import { getOrCreateDeviceId } from "../../../security/deviceRole";
import {
  createRootSyncCode, submitRootSyncCode, approveRootPairingRequest, acceptRootPairingResult, cancelSyncCode,
  onPairingRequest,
  onPairingResult,
  approvePairingRequest,
  rejectPairingRequest,
  submitSyncCode,
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
import type { RendezvousConfig } from "../../../net/rendezvousSignaling";
import {
  setRendezvousBaseUrl as persistRendezvousBaseUrl,
  setRendezvousUseOnion as persistRendezvousUseOnion,
  getRendezvousBaseUrl,
  getRendezvousUseOnion,
} from "../../../security/preferences";
import { getDhPublicKey, getIdentityPublicKey } from "../../../security/identityKeys";
import { syncApprovedDeviceHistory, publishDeviceAuthorization } from "../../../sync/syncEngine";
import { captureLocalOperationContext } from "../../../accounts/receiveContext";
import { onAccountOwnerChange } from "../../../accounts/accountOwnerLifecycle";
import { getAccountRootIdentity, getAuthorizedDeviceRegistry, createDeviceAuthorization, commitDeviceAuthorization,
  enrollAccountFreshness, recoverAccountFreshness, readSignedDeviceRegistry,
  type DeviceAuthorization } from "../../../devices/deviceApprovals";
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
  const [freshnessBusy, setFreshnessBusy] = useState(false);
  const [historyPolicy, setHistoryPolicy] = useState<"ALL" | "LAST_30_DAYS" | "NEW_ONLY" | "">("");
  const [approvedDevices, setApprovedDevices] = useState<DeviceAuthorization[]>([]);
  const [canRevoke, setCanRevoke] = useState(false);
  const activeLinkCode = useRef<string | null>(null);
  useEffect(() => {
    const stop = onAccountOwnerChange(() => {
      setApprovedDevices([]); setCanRevoke(false); setPairingRequest(null); setSyncCodeState(null);
      setLinkRequestId(null); setLinkBusy(false); setLinkStatus("idle"); setLinkMessage("");
      activeLinkCode.current = null;
    });

    return () => { stop(); };
  }, []);
  const linkTimeoutRef = useRef<number | null>(null);
  const initialRendezvousConfigRef = useRef(resolveInternalRendezvousConfig());

  const [rendezvousBaseUrlDraft, setRendezvousBaseUrlDraft] = useState(
    initialRendezvousConfigRef.current.baseUrl
  );

  const [rendezvousUseOnionProxy, setRendezvousUseOnionProxy] = useState(
    initialRendezvousConfigRef.current.useOnionProxy
  );

  const [rendezvousSaveStatus, setRendezvousSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [rendezvousError, setRendezvousError] = useState("");
  const rendezvousSaveInFlight = useRef(false);

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

  useEffect(() => {
    if (!open || view !== "devices") return;
    const config = resolveInternalRendezvousConfig();
    setRendezvousBaseUrlDraft(config.baseUrl);
    setRendezvousUseOnionProxy(config.useOnionProxy);
    setRendezvousSaveStatus("idle");
    setRendezvousError("");
  }, [open, view]);

  const buildRendezvousConfig = useCallback((): RendezvousConfig => {
    const fallback = resolveInternalRendezvousConfig();
    const baseUrl = fallback.baseUrl;
    const useOnionProxy = fallback.useOnionProxy;

    return {
      baseUrl,
      useOnionProxy,
      onionProxyUrl: null,
    };
  }, []);

  const startGuestRendezvous = useCallback(
    (syncCode: string) => {
      stopGuestRendezvous();

      const session = startRendezvousPairingAsGuest({
        syncCode,
        deviceId: getOrCreateDeviceId(),
        rendezvousConfig: buildRendezvousConfig(),
      });

      guestRendezvousRef.current = session;
      setGuestRendezvousStatus(session.getStatus());
      guestRendezvousUnsubRef.current = session.onStatus((status) => {
        setGuestRendezvousStatus(status);
      });
    },
    [buildRendezvousConfig, stopGuestRendezvous]
  );

  const handleRendezvousBaseUrlChange = useCallback((value: string) => {
    setRendezvousBaseUrlDraft(value);
    setRendezvousSaveStatus("idle");
    setRendezvousError("");
  }, []);

  const handleRendezvousBaseUrlSave = useCallback(async () => {
    if (rendezvousSaveInFlight.current) return;
    const normalized = rendezvousBaseUrlDraft.trim();

    try {
      const url = new URL(normalized);

      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("invalid-url");
    } catch {
      setRendezvousSaveStatus("error");
      setRendezvousError(t("올바른 HTTP 또는 HTTPS 서버 주소를 입력하세요.", "Enter a valid HTTP or HTTPS server address."));

      return;
    }

    rendezvousSaveInFlight.current = true;
    setRendezvousSaveStatus("saving");
    setRendezvousError("");

    try {
      await persistRendezvousBaseUrl(normalized);

      if (await getRendezvousBaseUrl() !== normalized) throw new Error("storage-write-failed");
      setRendezvousBaseUrlDraft(normalized);
      setRendezvousSaveStatus("saved");
    } catch (error) {
      console.error("Failed to save rendezvous URL", error);
      setRendezvousSaveStatus("error");
      setRendezvousError(t("저장하지 못했습니다. 서버 사용 승인을 확인한 뒤 다시 시도하세요.", "Could not save. Check the server approval and try again."));
    } finally {
      rendezvousSaveInFlight.current = false;
    }
  }, [rendezvousBaseUrlDraft, t]);

  const handleRendezvousUseOnionChange = useCallback(
    async (value: boolean) => {
      if (rendezvousSaveInFlight.current) return;
      rendezvousSaveInFlight.current = true;
      const previous = rendezvousUseOnionProxy;
      setRendezvousUseOnionProxy(value);
      setRendezvousSaveStatus("saving");
      setRendezvousError("");

      try {
        await persistRendezvousUseOnion(value);

        if (await getRendezvousUseOnion() !== value) throw new Error("storage-write-failed");
        setRendezvousSaveStatus(rendezvousBaseUrlDraft.trim() === resolveInternalRendezvousConfig().baseUrl ? "saved" : "idle");
      } catch (error) {
        console.error("Failed to save onion signaling option", error);
        setRendezvousUseOnionProxy(previous);
        setRendezvousSaveStatus("error");
        setRendezvousError(t("Onion 설정을 저장하지 못했습니다. 다시 시도하세요.", "Could not save the Onion setting. Try again."));
      } finally {
        rendezvousSaveInFlight.current = false;
      }
    },
    [rendezvousBaseUrlDraft, rendezvousUseOnionProxy, t]
  );

  const handleApprovedResult = useCallback(
    async (result: PairingResult) => {
      setLinkBusy(false);
      const event = result.event;

      try {
        if (result.authorizations) {
          if (!activeLinkCode.current || !historyPolicy) throw new Error("HISTORY_POLICY_REQUIRED");
          const approver = await acceptRootPairingResult(activeLinkCode.current, result);
          await startDeviceSyncAsInitiator({ deviceId: approver.deviceId, identityPub: approver.identityPub, dhPub: approver.dhPub });
          await syncApprovedDeviceHistory(approver.deviceId, historyPolicy);
          setLinkStatus("approved"); setLinkBusy(false);
          setLinkMessage(t("기기가 승인되었습니다. 선택한 범위를 동기화합니다.", "Device approved. Syncing the selected history."));

          return;
        }

        if (!event) throw new Error("DEVICE_APPROVAL_MISSING");
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
    [deviceSyncTransportPolicy, historyPolicy, stopGuestRendezvous, t]
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
      if (linkTimeoutRef.current) window.clearTimeout(linkTimeoutRef.current);
      linkTimeoutRef.current = null;

      if (activeLinkCode.current) cancelSyncCode(activeLinkCode.current);

      if (syncCodeState?.code) cancelSyncCode(syncCodeState.code);
      stopHostRendezvous();
      stopGuestRendezvous();
    }

    return () => {
      if (linkTimeoutRef.current) window.clearTimeout(linkTimeoutRef.current);
      linkTimeoutRef.current = null;

      if (activeLinkCode.current) cancelSyncCode(activeLinkCode.current);

      if (syncCodeState?.code) cancelSyncCode(syncCodeState.code);
      stopHostRendezvous();
      stopGuestRendezvous();
    };
  }, [open, stopGuestRendezvous, stopHostRendezvous, syncCodeState?.code]);

  const syncCodeRemainingMs = syncCodeState
    ? Math.max(0, syncCodeState.expiresAt - syncCodeNow)
    : 0;

  const syncCodeExpired = Boolean(syncCodeState && syncCodeRemainingMs <= 0);

  useEffect(() => {
    if (!syncCodeState || syncCodeExpired) {
      stopHostRendezvous();
    }
  }, [stopHostRendezvous, syncCodeExpired, syncCodeState]);

  const handleGenerateSyncCode = useCallback(async () => {
    try {
      if (syncCodeState?.code) cancelSyncCode(syncCodeState.code);
      const next = await createRootSyncCode();
      setSyncCodeState(next);
      setSyncCodeNow(Date.now());
      setPairingRequest(null);
      setPairingRequestError("");
    } catch (error) {
      console.error("Failed to generate sync code", error);
      addToast({ message: t("코드 생성에 실패했습니다.", "Failed to generate code.") });
    }
  }, [addToast, syncCodeState?.code, t]);

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

    if (!pairingRequest.rootLink) {
      setPairingRequestError(t("이 버전은 이전 Direct 연결을 지원하지 않습니다. 새 계정 Root 연결 코드를 사용하세요.", "Legacy Direct linking is unsupported in this release. Use a new Account Root linking code."));

      return;
    }

    setPairingRequestBusy(true);
    setPairingRequestError("");

    try {
      if (pairingRequest.rootLink) {
        const event = await approveRootPairingRequest(pairingRequest.requestId);
        await publishDeviceAuthorization(event);
        await startDeviceSyncAsApprover({ deviceId: event.deviceId, identityPub: event.identityPub, dhPub: event.dhPub });
        setPairingRequest(null);
        addToast({ message: t("새 기기를 승인했습니다.", "New device approved.") });

        return;
      }

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

    if (!code.startsWith("NKC-DEVICE2-")) {
      setLinkStatus("error");
      setLinkMessage(t("이 버전은 이전 Direct 연결 코드를 지원하지 않습니다. 기존 기기에서 새 계정 Root 연결 코드를 생성하세요.", "Legacy Direct codes are unsupported in this release. Generate a new Account Root linking code on your existing device."));

      return;
    }

    setLinkBusy(true);
    setLinkStatus("pending");
    setLinkMessage(t("승인을 기다리는 중...", "Waiting for approval..."));

    try {
      if (code.startsWith("NKC-DEVICE2-")) {
        if (!historyPolicy) throw new Error("HISTORY_POLICY_REQUIRED");
        const requestId = await submitRootSyncCode(code);
        activeLinkCode.current = code;
        setLinkRequestId(requestId);

        if (linkTimeoutRef.current) window.clearTimeout(linkTimeoutRef.current);
        linkTimeoutRef.current = window.setTimeout(() => {
          cancelSyncCode(code); setLinkBusy(false); setLinkStatus("error");
          setLinkMessage(t("기존 기기의 응답이 없습니다. 온라인 상태를 확인하세요.", "No response from the existing device. Check it is online."));
        }, 30_000);

        return;
      }

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
  }, [historyPolicy, linkCodeDraft, startGuestRendezvous, stopGuestRendezvous, t]);

  const refreshDevices = useCallback(async () => {
    const context = await captureLocalOperationContext();

    if (!context) return;
    const root = await getAccountRootIdentity(context);
    const devices = root ? Object.values(await readSignedDeviceRegistry(context)) : [];
    const localIdentity = encodeBase64Url(await getIdentityPublicKey(context));
    context.vault.assertLocal();
    setApprovedDevices(devices);
    const local = devices.find(device => device.deviceId === getOrCreateDeviceId(context));
    setCanRevoke(Boolean(root && local?.kind === "DEVICE_ADDED" && local.identityPub === localIdentity &&
      (window.nkcExperimental?.freshnessWitness !== true || root === localIdentity)));
  }, []);

  useEffect(() => { if (open && view === "devices") void refreshDevices().catch(() => {}); }, [open, view, refreshDevices, pairingRequest, linkStatus]);

  const handleUnlinkDevice = useCallback(async (deviceId: string) => {
    let revokedLocally = false;

    try {
      const context = await captureLocalOperationContext();

      if (!context || deviceId === getOrCreateDeviceId(context)) throw new Error("DEVICE_AUTHORITY_REQUIRED");
      const previous = (await getAuthorizedDeviceRegistry(context))[deviceId];

      if (!previous || previous.kind !== "DEVICE_ADDED") throw new Error("DEVICE_AUTHORITY_REQUIRED");

      const event = await createDeviceAuthorization({ kind: "DEVICE_REVOKED", deviceId, identityPub: previous.identityPub,
        dhPub: previous.dhPub, role: previous.role, epoch: previous.epoch + 1, route: previous.route }, context);

      await commitDeviceAuthorization(event, event.accountRootIdentityPub, context);
      revokedLocally = true;
      await refreshDevices().catch(() => {});
      await publishDeviceAuthorization(event);
    } catch { addToast({ message: revokedLocally

      ? t("이 기기에서는 해제되었습니다. 다른 기기의 해제 상태는 아직 확인되지 않았습니다.", "Revoked on this device. Revocation on other devices is not yet confirmed.")
      : t("기기를 해제하지 못했습니다.", "Could not unlink device.") }); }
    finally { await refreshDevices().catch(() => {}); }
  }, [addToast, refreshDevices, t]);

  const handleFreshnessAction = useCallback(async (action: "enroll" | "recover") => {
    setFreshnessBusy(true);
    try {
      const context = await captureLocalOperationContext();
      if (!context) throw new Error("OWNER_REQUIRED");
      if (action === "enroll") await enrollAccountFreshness(context);
      else await recoverAccountFreshness(context);
      await context.vault.assertMain();
      addToast({ message: t("기기 권한 상태를 확인했습니다. 세션 복구는 별도로 필요할 수 있습니다.", "Device authority verified. Session recovery may still be required.") });
      await refreshDevices();
    } catch {
      addToast({ message: t("보안 상태 서비스에 연결하거나 복구하지 못했습니다. 확인되지 않은 기기 권한은 사용할 수 없습니다.", "Could not reach the security state service or recover authority. Unverified device authority cannot be used.") });
    } finally { setFreshnessBusy(false); }
  }, [addToast, refreshDevices, t]);

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
        : "nkc-error";

  return {
    historyPolicy, setHistoryPolicy, approvedDevices, canRevoke, currentDeviceId: getOrCreateDeviceId(), handleUnlinkDevice,
    freshnessBusy, handleFreshnessAction,
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
    rendezvousBaseUrlDraft,
    rendezvousUseOnionProxy,
    handleRendezvousBaseUrlChange,
    handleRendezvousBaseUrlSave,
    rendezvousSaveStatus,
    rendezvousError,
    handleRendezvousUseOnionChange,
    hostRendezvousStatus,
    guestRendezvousStatus,
    handleDeviceSyncPolicyChange,
  };
};
