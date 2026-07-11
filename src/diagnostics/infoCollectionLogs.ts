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
  lokinet?: string;
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

const withSequence = <T extends object>(payload: T) => ({
  ...payload,
  seq: ++infoSequence,
});

export const emitFriendAddInfoLog = (detail: FriendAddInfoLogInput) => {
  if (!isInfoCollectionEnabled()) return;
  const payload = withSequence({
    ...detail,
    timestamp: new Date().toISOString(),
  });
  console.info("[test][friend-add]", payload);
  dispatchInfoEvent(INFO_EVENT_FRIEND_ADD, payload);
};

export const emitFriendRouteOutgoingInfoLog = (detail: FriendRouteOutgoingInfoLogInput) => {
  if (!isInfoCollectionEnabled()) return;
  const payload = withSequence({
    ...detail,
    timestamp: new Date().toISOString(),
  });
  console.info("[test][friend-route]", payload);
  dispatchInfoEvent(INFO_EVENT_FRIEND_ROUTE, payload);
};

export const emitFriendRouteIncomingInfoLog = (detail: FriendRouteIncomingInfoLogInput) => {
  if (!isInfoCollectionEnabled()) return;
  const payload = withSequence({
    ...detail,
    timestamp: new Date().toISOString(),
  });
  console.info("[test][friend-route]", payload);
  dispatchInfoEvent(INFO_EVENT_FRIEND_ROUTE, payload);
};

export const emitRouterInfoLog = (detail: RouterInfoLogInput) => {
  if (!isInfoCollectionEnabled()) return;
  const payload = withSequence({
    ...detail,
    timestamp: new Date().toISOString(),
  });
  console.info("[test][router]", payload);
  dispatchInfoEvent(INFO_EVENT_ROUTER, payload);
};

export const emitFlowTraceLog = (detail: FlowTraceLogInput) => {
  if (!isInfoCollectionEnabled()) return;
  const payload = withSequence({
    ...detail,
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
