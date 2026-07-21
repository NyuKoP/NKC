export type MessageDeliveryStatus = "queued" | "sent" | "delivered" | "read";

type ResolveMessageDeliveryStatusOptions = {
  outboxStatus?: "pending" | "in_flight" | "acked" | "expired";
  delivered: boolean;
  read: boolean;
  readReceiptsEnabled: boolean;
};

export const resolveMessageDeliveryStatus = ({
  outboxStatus,
  delivered,
  read,
  readReceiptsEnabled,
}: ResolveMessageDeliveryStatusOptions): MessageDeliveryStatus => {
  if (readReceiptsEnabled && read) return "read";
  if (delivered || outboxStatus === "acked") return "delivered";
  // In a serverless app, a durable outbox row means encryption and local
  // preparation are complete. `in_flight` additionally means the selected
  // transport (normally Tor) accepted the packet. Neither implies that the
  // recipient device has received it; only its ACK promotes it to delivered.
  if (outboxStatus === "pending" || outboxStatus === "in_flight") return "sent";
  return "queued";
};

export const MESSAGE_DELIVERY_LABELS: Record<
  MessageDeliveryStatus,
  { ko: string; en: string }
> = {
  queued: { ko: "대기 중", en: "Preparing" },
  sent: { ko: "보냄", en: "Ready / sent to Tor" },
  delivered: { ko: "전달됨", en: "Delivered" },
  read: { ko: "읽음", en: "Read" },
};
