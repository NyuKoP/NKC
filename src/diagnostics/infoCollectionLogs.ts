import { appendTestLog } from "../utils/testLogSink";
import { isInfoCollectionEnabled } from "./infoCollectionConfig";

export const INFO_EVENT_FRIEND_ADD = "nkc:test:friend-add";
export const INFO_EVENT_FRIEND_ROUTE = "nkc:test:friend-route";
export const INFO_EVENT_ROUTER = "nkc:test:router";

type FriendControlFrameType = "friend_req" | "friend_accept" | "friend_decline";

export type InfoLogErrorDetail = {
  name?: string;
  message: string;
  code?: string;
  stackTop?: string;
  causeMessage?: string;
};

export type FriendAddInfoLogInput = {
  result: "progress" | "added" | "not_added";
  stage: string;
  source?: string;
  operationId?: string;
  traceId?: string;
  elapsedMs?: number;
  message?: string;
  profileId?: string;
  friendId?: string;
  requestSent?: boolean;
  context?: Record<string, unknown>;
  errorDetail?: InfoLogErrorDetail;
};

export type FriendRouteOutgoingInfoLogInput = {
  direction: "outgoing";
  status: "attempt" | "sent" | "failed";
  frameType: FriendControlFrameType;
  source?: string;
  operationId?: string;
  traceId?: string;
  elapsedMs?: number;
  via?: "directP2P" | "selfOnion" | "onionRouter";
  messageId: string;
  convId: string;
  senderDeviceId?: string;
  toDeviceId?: string;
  torOnion?: string;
  alternateRoute?: string;
  error?: string;
  context?: Record<string, unknown>;
  errorDetail?: InfoLogErrorDetail;
};

export type FriendRouteIncomingInfoLogInput = {
  direction: "incoming";
  status: "received" | "handled" | "failed";
  frameType: FriendControlFrameType;
  source?: string;
  operationId?: string;
  traceId?: string;
  elapsedMs?: number;
  via: "directP2P" | "selfOnion" | "onionRouter";
  packetId: string;
  convId?: string;
  fromDeviceId?: string;
  toDeviceId?: string;
  error?: string;
  context?: Record<string, unknown>;
  errorDetail?: InfoLogErrorDetail;
};

export type RouterInfoLogInput = {
  status: "attempt" | "progress" | "ready" | "failed";
  stage: string;
  source?: string;
  operationId?: string;
  elapsedMs?: number;
  message?: string;
  context?: Record<string, unknown>;
  error?: string;
  errorDetail?: InfoLogErrorDetail;
};

export type FlowTraceLogInput = {
  event: string;
  level?: "debug" | "info" | "warn" | "error";
  source?: string;
  operationId?: string;
  traceId?: string;
  [key: string]: unknown;
};

type BrowserEventLike = {
  detail?: unknown;
};

type BrowserEventHandler = (event: BrowserEventLike) => void;

type BrowserWindowLike = {
  dispatchEvent: (event: unknown) => boolean;
  addEventListener: (eventName: string, handler: BrowserEventHandler) => void;
  removeEventListener: (eventName: string, handler: BrowserEventHandler) => void;
};

type CustomEventConstructorLike = new (
  eventName: string,
  init?: { detail?: unknown }
) => unknown;

const getBrowserWindow = () => {
  const candidate = globalThis as { window?: BrowserWindowLike };
  return candidate.window ?? null;
};

const createBrowserCustomEvent = (eventName: string, detail: unknown) => {
  const candidate = globalThis as { CustomEvent?: CustomEventConstructorLike };
  const CustomEventCtor = candidate.CustomEvent;
  return CustomEventCtor ? new CustomEventCtor(eventName, { detail }) : null;
};

const dispatchInfoEvent = (eventName: string, payload: unknown) => {
  if (!isInfoCollectionEnabled()) return;
  const browserWindow = getBrowserWindow();
  const event = createBrowserCustomEvent(eventName, payload);
  if (!browserWindow || !event) return;
  browserWindow.dispatchEvent(event);
};

let infoSequence = 0;

const SENSITIVE_LOG_KEYS = new Set([
  "friendcode",
  "toronion",
  "alternateRoute",
  "onionaddr",
  "onionaddress",
  "destination",
  "destinationurl",
  "todeviceid",
  "fromdeviceid",
  "senderdeviceid",
  "profileid",
  "friendid",
  "identitypub",
  "dhpub",
  "envelope",
  "ciphertext",
  "plaintext",
  "authtoken",
  "password",
  "credential",
  "credentials",
  "icecandidate",
  "ipaddress",
]);

const sanitizeLogString = (value: string) =>
  value
    .replace(/\b[a-z2-7]{56}\.onion\b/gi, "[onion-redacted]")
    .replace(/\bNKC1-[A-Za-z0-9_-]+\b/g, "[friend-code-redacted]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[ip-redacted]")
    .replace(/([?&]deviceId=)[^&\s]+/gi, "$1[redacted]")
    .replace(
      /\b((?:conv|event|record|friend|device|profile|message|packet|op)?id=)(?!\[redacted\])[^\s,}\]&]+/gi,
      "$1[redacted]"
    );

export const sanitizeInfoLogPayload = <T>(value: T, depth = 0): T => {
  if (typeof value === "string") return sanitizeLogString(value) as T;
  if (value === null || typeof value !== "object" || depth >= 8) return value;
  if (value instanceof Error) {
    const coded = value as Error & { code?: unknown };
    return {
      name: value.name || "Error",
      ...(typeof coded.code === "string" ? { code: sanitizeLogString(coded.code) } : {}),
    } as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeInfoLogPayload(item, depth + 1)) as T;
  }
  const sanitized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    const isIdentifier =
      !normalizedKey.startsWith("has") &&
      (normalizedKey.endsWith("deviceid") ||
        normalizedKey.endsWith("friendid") ||
        normalizedKey.endsWith("profileid") ||
        normalizedKey.endsWith("friendidhash"));
    sanitized[key] = SENSITIVE_LOG_KEYS.has(normalizedKey) || isIdentifier
      ? "[redacted]"
      : sanitizeInfoLogPayload(item, depth + 1);
  }
  return sanitized as T;
};

const withSequence = <T extends object>(payload: T) => ({
  ...payload,
  seq: ++infoSequence,
});

export const emitFriendAddInfoLog = (detail: FriendAddInfoLogInput) => {
  if (!isInfoCollectionEnabled()) return;
  const payload = withSequence({
    ...sanitizeInfoLogPayload(detail),
    timestamp: new Date().toISOString(),
  });
  console.info("[test][friend-add]", payload);
  dispatchInfoEvent(INFO_EVENT_FRIEND_ADD, payload);
};

export const emitFriendRouteOutgoingInfoLog = (detail: FriendRouteOutgoingInfoLogInput) => {
  if (!isInfoCollectionEnabled()) return;
  const payload = withSequence({
    ...sanitizeInfoLogPayload(detail),
    timestamp: new Date().toISOString(),
  });
  console.info("[test][friend-route]", payload);
  dispatchInfoEvent(INFO_EVENT_FRIEND_ROUTE, payload);
};

export const emitFriendRouteIncomingInfoLog = (detail: FriendRouteIncomingInfoLogInput) => {
  if (!isInfoCollectionEnabled()) return;
  const payload = withSequence({
    ...sanitizeInfoLogPayload(detail),
    timestamp: new Date().toISOString(),
  });
  console.info("[test][friend-route]", payload);
  dispatchInfoEvent(INFO_EVENT_FRIEND_ROUTE, payload);
};

export const emitRouterInfoLog = (detail: RouterInfoLogInput) => {
  if (!isInfoCollectionEnabled()) return;
  const payload = withSequence({
    ...sanitizeInfoLogPayload(detail),
    timestamp: new Date().toISOString(),
  });
  console.info("[test][router]", payload);
  dispatchInfoEvent(INFO_EVENT_ROUTER, payload);
};

export const emitFlowTraceLog = (detail: FlowTraceLogInput) => {
  if (!isInfoCollectionEnabled()) return;
  const payload = withSequence({
    ...sanitizeInfoLogPayload(detail),
    timestamp: new Date().toISOString(),
  });
  const event = typeof payload.event === "string" ? payload.event : "unknown";
  const label = `[trace][${event}]`;
  const level = payload.level;
  if (level === "debug") {
    console.debug(label, payload);
  } else if (level === "warn") {
    console.warn(label, payload);
  } else if (level === "error") {
    console.error(label, payload);
  } else {
    console.info(label, payload);
  }
  dispatchInfoEvent(INFO_EVENT_ROUTER, payload);
};

let infoSinkAttached = false;

export const attachInfoCollectionLogSink = () => {
  if (!isInfoCollectionEnabled()) return () => {};
  const browserWindow = getBrowserWindow();
  if (!browserWindow) return () => {};
  if (infoSinkAttached) return () => {};
  infoSinkAttached = true;

  const handleFriendAdd = (event: BrowserEventLike) => {
    const detail = event.detail;
    void appendTestLog("friend-add", detail);
  };
  const handleFriendRoute = (event: BrowserEventLike) => {
    const detail = event.detail;
    void appendTestLog("friend-route", detail);
  };
  const handleRouter = (event: BrowserEventLike) => {
    const detail = event.detail;
    void appendTestLog("router", detail);
  };

  browserWindow.addEventListener(INFO_EVENT_FRIEND_ADD, handleFriendAdd);
  browserWindow.addEventListener(INFO_EVENT_FRIEND_ROUTE, handleFriendRoute);
  browserWindow.addEventListener(INFO_EVENT_ROUTER, handleRouter);

  return () => {
    infoSinkAttached = false;
    browserWindow.removeEventListener(INFO_EVENT_FRIEND_ADD, handleFriendAdd);
    browserWindow.removeEventListener(INFO_EVENT_FRIEND_ROUTE, handleFriendRoute);
    browserWindow.removeEventListener(INFO_EVENT_ROUTER, handleRouter);
  };
};
