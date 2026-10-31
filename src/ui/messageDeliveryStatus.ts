export type MessageDeliveryStatus = "queued" | "sent" | "delivered" | "read" | "failed";

type ResolveMessageDeliveryStatusOptions = {
  outboxStatus?: "pending" | "in_flight" | "acked" | "expired" | "prepared" | "handoff_in_progress" | "result_uncertain" | "native_owned" | "native_terminal";
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

  if (outboxStatus === "expired") return "failed";

  // Pending is local queueing; only an ACK proves peer delivery.
  if (outboxStatus === "in_flight") return "sent";

  return "queued";
};

export const MESSAGE_DELIVERY_LABELS: Record<
  MessageDeliveryStatus,
  { ko: string; en: string }
> = {
  queued: { ko: "전송 대기", en: "Waiting to send" },
  sent: { ko: "전달 확인 대기", en: "Awaiting delivery" },
  delivered: { ko: "전달됨", en: "Delivered" },
  read: { ko: "읽음", en: "Read" },
  failed: { ko: "전송 만료", en: "Send expired" },
};
