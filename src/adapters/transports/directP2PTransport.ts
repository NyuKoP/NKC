import type { Transport, TransportPacket, TransportState } from "./types";

type Handler<T> = (payload: T) => void;

type DirectSignalExt = {
  createOfferCode: () => Promise<string>;
  acceptSignalCode: (code: string) => Promise<void>;
  onSignalCode: (cb: (code: string) => void) => void;
};

type SignalMessage =
  | { v: 1; t: "offer"; sdp: RTCSessionDescriptionInit }
  | { v: 1; t: "answer"; sdp: RTCSessionDescriptionInit }
  | { v: 1; t: "ice"; c: RTCIceCandidateInit };

const SIGNAL_PREFIX = "NKC-RTC1.";
const DATA_CHANNEL_LABEL = "nkc-direct-v1";
const DEFAULT_STUN_URL = "stun:stun.l.google.com:19302";

const toBase64Url = (value: string) => {
  const b64 = btoa(value);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

const fromBase64Url = (value: string) => {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4;
  const withPad = pad ? padded + "=".repeat(4 - pad) : padded;
  return atob(withPad);
};

const encodeSignal = (message: SignalMessage) => {
  const json = JSON.stringify(message);
  return `${SIGNAL_PREFIX}${toBase64Url(json)}`;
};

const decodeSignal = (code: string): SignalMessage => {
  if (!code.startsWith(SIGNAL_PREFIX)) {
    throw new Error("Invalid signal code prefix.");
  }
  const payload = code.slice(SIGNAL_PREFIX.length);
  const json = fromBase64Url(payload);
  const parsed = JSON.parse(json) as SignalMessage;
  if (!parsed || parsed.v !== 1 || !parsed.t) {
    throw new Error("Invalid signal code payload.");
  }
  return parsed;
};

const mapIceState = (value: RTCIceConnectionState | undefined): TransportState => {
  if (value === "connected" || value === "completed") return "connected";
  if (value === "disconnected") return "degraded";
  if (value === "failed") return "failed";
  if (value === "closed") return "idle";
  if (value === "checking" || value === "new") return "connecting";
  return "connecting";
};

export const createDirectP2PTransport = (): Transport => {
  let state: TransportState = "idle";
  const messageHandlers: Array<Handler<TransportPacket>> = [];
  const ackHandlers: Array<Handler<{ id: string; rttMs: number }>> = [];
  const stateHandlers: Array<Handler<TransportState>> = [];
  const signalHandlers: Array<Handler<string>> = [];
  let peerConnection: RTCPeerConnection | null = null;
  let dataChannel: RTCDataChannel | null = null;
  let started = false;
  let pendingIce: RTCIceCandidateInit[] = [];

  const emitState = (next: TransportState) => {
    state = next;
    stateHandlers.forEach((handler) => handler(next));
  };

  const emitSignal = (message: SignalMessage) => {
    const code = encodeSignal(message);
    signalHandlers.forEach((handler) => handler(code));
  };

  const handleDataMessage = (data: unknown) => {
    let raw = "";
    if (typeof data === "string") {
      raw = data;
    } else if (data instanceof ArrayBuffer) {
      raw = new TextDecoder().decode(new Uint8Array(data));
    } else if (data instanceof Uint8Array) {
      raw = new TextDecoder().decode(data);
    } else {
      return;
    }
    try {
      const parsed = JSON.parse(raw) as TransportPacket;
      if (!parsed || typeof parsed.id !== "string") return;
      messageHandlers.forEach((handler) => handler(parsed));
    } catch {
      // ignore invalid packets
    }
  };

  const setupDataChannel = (channel: RTCDataChannel) => {
    dataChannel = channel;
    dataChannel.onopen = () => emitState("connected");
    dataChannel.onmessage = (event) => handleDataMessage(event.data);
    dataChannel.onclose = () => emitState("idle");
    dataChannel.onerror = () => emitState("failed");
  };

  const ensurePeerConnection = () => {
    if (peerConnection) return peerConnection;
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: DEFAULT_STUN_URL }],
    });
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        const payload = event.candidate.toJSON
          ? event.candidate.toJSON()
          : {
              candidate: event.candidate.candidate,
              sdpMid: event.candidate.sdpMid ?? undefined,
              sdpMLineIndex: event.candidate.sdpMLineIndex ?? undefined,
              usernameFragment: event.candidate.usernameFragment ?? undefined,
            };
        emitSignal({ v: 1, t: "ice", c: payload });
      }
    };
    pc.oniceconnectionstatechange = () => {
      emitState(mapIceState(pc.iceConnectionState));
    };
    pc.ondatachannel = (event) => {
      setupDataChannel(event.channel);
    };
    peerConnection = pc;
    return pc;
  };

  const flushPendingIce = async () => {
    if (!peerConnection || !peerConnection.remoteDescription) return;
    const queued = pendingIce;
    pendingIce = [];
    for (const candidate of queued) {
      try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      } catch {
        // ignore invalid candidates
      }
    }
  };

  const transport = {
    name: "directP2P",
    async start() {
      if (started) return;
      started = true;
      emitState("connecting");
      ensurePeerConnection();
    },
    async stop() {
      started = false;
      pendingIce = [];
      if (dataChannel) {
        try {
          dataChannel.close();
        } catch {
          // ignore close errors
        }
        dataChannel = null;
      }
      if (peerConnection) {
        try {
          peerConnection.close();
        } catch {
          // ignore close errors
        }
        peerConnection = null;
      }
      emitState("idle");
    },
    async send(packet: TransportPacket) {
      if (!dataChannel || dataChannel.readyState !== "open") {
        const error = new Error("DIRECT_NOT_OPEN: Direct P2P data channel is not open") as Error & {
          code?: string;
        };
        error.code = "DIRECT_NOT_OPEN";
        throw error;
      }
      dataChannel.send(JSON.stringify(packet));
      ackHandlers.forEach((handler) => handler({ id: packet.id, rttMs: 0 }));
    },
    async createOfferCode() {
      await this.start();
      const pc = ensurePeerConnection();
      if (!dataChannel) {
        const channel = pc.createDataChannel(DATA_CHANNEL_LABEL, { ordered: true });
        setupDataChannel(channel);
      }
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (!pc.localDescription) {
        throw new Error("Failed to create local offer");
      }
      return encodeSignal({ v: 1, t: "offer", sdp: pc.localDescription });
    },
    async acceptSignalCode(code: string) {
      await this.start();
      const pc = ensurePeerConnection();
      const message = decodeSignal(code.trim());
      if (message.t === "offer") {
        await pc.setRemoteDescription(new RTCSessionDescription(message.sdp));
        await flushPendingIce();
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        if (!pc.localDescription) {
          throw new Error("Failed to create local answer");
        }
        emitSignal({ v: 1, t: "answer", sdp: pc.localDescription });
        return;
      }
      if (message.t === "answer") {
        await pc.setRemoteDescription(new RTCSessionDescription(message.sdp));
        await flushPendingIce();
        return;
      }
      if (message.t === "ice") {
        if (!message.c) return;
        if (!pc.remoteDescription) {
          pendingIce.push(message.c);
          return;
        }
        await pc.addIceCandidate(new RTCIceCandidate(message.c));
      }
    },
    onSignalCode(cb: (code: string) => void) {
      signalHandlers.push(cb);
    },
    onMessage(cb: (packet: TransportPacket) => void) {
      messageHandlers.push(cb);
    },
    onAck(cb: (id: string, rttMs: number) => void) {
      ackHandlers.push((payload) => cb(payload.id, payload.rttMs));
    },
    onState(cb: (state: TransportState) => void) {
      stateHandlers.push(cb);
      cb(state);
    },
  };
  return transport as Transport & DirectSignalExt;
};
