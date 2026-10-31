import { useEffect, useState } from "react";
import { useAppStore } from "../app/store";
import type { MediaRef } from "../db/repo";
import { getMediaTransferProgress, subscribeMediaTransferProgress, type MediaTransferProgress } from "../storage/mediaTransferStore";
import { summarizeMediaTransfers } from "../ui/mediaTransferSummary";

export const MediaTransferStatus = ({ media }: { media: MediaRef[] }) => {
  const language = useAppStore((state) => state.ui.language);
  const ownerId = useAppStore((state) => state.userProfile?.id);
  const [snapshot, setSnapshot] = useState<{ ownerId?: string; rows: Record<string, MediaTransferProgress> }>({ rows: {} });
  const progress = snapshot.ownerId === ownerId ? snapshot.rows : {};
  const ids = JSON.stringify(media.map((item) => item.ownerId));
  useEffect(() => {
    let active = true;
    const ownerIds: unknown = JSON.parse(ids);

    if (!Array.isArray(ownerIds) || !ownerIds.every((id): id is string => typeof id === "string")) {
      throw new Error("Invalid media owner IDs");
    }

    const unsubscribers = ownerIds.map((id) => {
      let updated = false;

      const unsubscribe = subscribeMediaTransferProgress(id, (next) => {
        updated = true;

        if (active) setSnapshot((previous) => ({ ownerId, rows: { ...(previous.ownerId === ownerId ? previous.rows : {}), [id]: next } }));
      });

      void getMediaTransferProgress(id).then((next) => {
        if (active && !updated && next) setSnapshot((previous) => ({ ownerId, rows: { ...(previous.ownerId === ownerId ? previous.rows : {}), [id]: next } }));
      }).catch((error) => console.error("Failed to load media transfer progress", error));

      return unsubscribe;
    });

    return () => { active = false; unsubscribers.forEach((unsubscribe) => unsubscribe()); };
  }, [ids, ownerId]);

  if (!media.some((item) => progress[item.ownerId])) return null;
  const summary = summarizeMediaTransfers(media, progress);
  const en = language === "en";

  const label = summary.complete ? (en ? "Delivered" : "전달 완료")
    : summary.failed ? (en ? "Transfer interrupted" : "전송 중단")
    : summary.percent > 0 ? (en ? "Delivering" : "전달 중")
    : (en ? "Waiting for recipient" : "수신 확인 대기");

  return (
    <div className="px-3 py-2 text-[11px]" data-testid="media-transfer-status">
      <div className="flex items-center justify-between gap-2">
        <span>{label}</span>
        <span className="tabular-nums">{summary.completed}/{media.length} · {summary.percent}%</span>
      </div>
      {!summary.complete && <div className="relative mt-1 h-1 overflow-hidden rounded-full" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={summary.percent} aria-label={en ? "Recipient confirmed progress" : "상대방 수신 확인 진행률"}>
        <div className="absolute inset-0 bg-current opacity-20" />
        <div className="relative h-full rounded-full bg-current" style={{ width: `${summary.percent}%` }} />
      </div>}
    </div>
  );
};
