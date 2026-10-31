const MESSAGE_MEDIA_READY_EVENT = "nkc:message-media-ready";

export const notifyMessageMediaReady = (ownerId: string) => {
  if (typeof window === "undefined" || !ownerId) return;
  window.dispatchEvent(
    new CustomEvent<{ ownerId: string }>(MESSAGE_MEDIA_READY_EVENT, {
      detail: { ownerId },
    })
  );
};

export const subscribeMessageMediaReady = (listener: (ownerId: string) => void) => {
  if (typeof window === "undefined") return () => {};

  const handler = (event: Event) => {
    const ownerId = (event as CustomEvent<{ ownerId?: unknown }>).detail?.ownerId;

    if (typeof ownerId === "string" && ownerId) listener(ownerId);
  };

  window.addEventListener(MESSAGE_MEDIA_READY_EVENT, handler);

  return () => window.removeEventListener(MESSAGE_MEDIA_READY_EVENT, handler);
};
