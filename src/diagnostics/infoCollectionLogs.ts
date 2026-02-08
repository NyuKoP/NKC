import { appendTestLog } from "../utils/testLogSink";
import { isInfoCollectionEnabled } from "./infoCollectionConfig";

export const INFO_EVENT_FRIEND_ADD = "nkc:test:friend-add";
export const INFO_EVENT_FRIEND_ROUTE = "nkc:test:friend-route";

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
  status: "sent" | "failed";
  frameType: FriendControlFrameType;
  source?: string;
  operationId?: string;
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

const dispatchInfoEvent = (eventName: string, payload: unknown) => {
  if (!isInfoCollectionEnabled()) return;
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(eventName, { detail: payload }));
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

let infoSinkAttached = false;

export const attachInfoCollectionLogSink = () => {
  if (!isInfoCollectionEnabled()) return () => {};
  if (typeof window === "undefined") return () => {};
  if (infoSinkAttached) return () => {};
  infoSinkAttached = true;

  const handleFriendAdd = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    void appendTestLog("friend-add", detail);
  };
  const handleFriendRoute = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    void appendTestLog("friend-route", detail);
  };

  window.addEventListener(INFO_EVENT_FRIEND_ADD, handleFriendAdd as EventListener);
  window.addEventListener(INFO_EVENT_FRIEND_ROUTE, handleFriendRoute as EventListener);

  return () => {
    infoSinkAttached = false;
    window.removeEventListener(INFO_EVENT_FRIEND_ADD, handleFriendAdd as EventListener);
    window.removeEventListener(INFO_EVENT_FRIEND_ROUTE, handleFriendRoute as EventListener);
  };
};
