import { useEffect, useMemo, useState, type ReactNode } from "react";
import { FileText } from "lucide-react";
import type { MediaRef } from "../db/repo";
import { loadMessageMedia } from "../db/repo";
import type { MessageGroup, MessageLike } from "./groupMessages";

export type ChatMessageLike = MessageLike & {
  convId: string;
  ts: number;
  text: string;
  media?: MediaRef;
};

type MessageGroupBubbleProps<T extends ChatMessageLike> = {
  group: MessageGroup<T>;
  isMine: boolean;
  onOpenMedia?: (items: T[], index: number) => void;
  footer?: ReactNode;
};

const formatBytes = (bytes: number) => {
  if (!Number.isFinite(bytes)) return "";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const digits = size >= 10 || unit === 0 ? 0 : 1;
  return `${size.toFixed(digits)} ${units[unit]}`;
};

const getTextBubbleClass = (text: string) => {
  const len = text.trim().length;
  if (len <= 6) return "max-w-[140px]";
  if (len <= 16) return "max-w-[220px]";
  if (len <= 32) return "max-w-[320px]";
  return "max-w-[420px]";
};

const getMediaBubbleClass = (count: number) => {
  if (count <= 2) return "max-w-[240px]";
  if (count <= 4) return "max-w-[320px]";
  if (count <= 9) return "max-w-[420px]";
  return "max-w-[520px]";
};

const isPreviewableMedia = (media: MediaRef) => media.mime.startsWith("image/");

type MediaThumbProps = {
  media: MediaRef;
  className?: string;
};

const MediaThumb = ({ media, className }: MediaThumbProps) => {
  const [blob, setBlob] = useState<Blob | null>(null);
  const isImage = media.mime.startsWith("image/");
  const previewUrl = useMemo(
    () => (isImage && blob ? URL.createObjectURL(blob) : null),
    [isImage, blob]
  );

  useEffect(() => {
    if (!isImage) return;
    let active = true;

    const load = async () => {
      try {
        const nextBlob = await loadMessageMedia(media);
        if (!nextBlob || !active) return;
        setBlob(nextBlob);
      } catch (error) {
        console.error("Failed to load media thumb", error);
      }
    };

    void load();

    return () => {
      active = false;
    };
  }, [isImage, media]);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const baseClass = className
    ? `${className} w-full rounded-md object-cover`
    : "aspect-square w-full rounded-md object-cover";

  if (!isImage) {
    return <div className={`${baseClass} bg-nkc-panelMuted`} />;
  }

  return previewUrl ? (
    <img
      src={previewUrl}
      alt={media.name}
      className={baseClass}
    />
  ) : (
    <div className={`${baseClass} bg-nkc-panelMuted`} />
  );
};

const FileAttachmentRow = ({ media }: { media: MediaRef }) => (
  <div className="flex items-center gap-2 text-xs">
    <FileText size={14} className="text-nkc-muted" />
    <div className="min-w-0">
      <div className="text-nkc-text line-clamp-1">{media.name}</div>
      <div className="text-[11px] text-nkc-muted">{formatBytes(media.size)}</div>
    </div>
  </div>
);

export default function MessageGroupBubble<T extends ChatMessageLike>({
  group,
  isMine,
  onOpenMedia,
  footer,
}: MessageGroupBubbleProps<T>) {
  const textItems = group.items.filter((item) => item.kind === "text" && item.text);
  const mediaItems = group.items.filter((item) => item.kind === "media" && item.media);
  const imageItems = mediaItems.filter((item) =>
    item.media ? isPreviewableMedia(item.media) : false
  );
  const fileItems = mediaItems.filter((item) =>
    item.media ? !isPreviewableMedia(item.media) : false
  );
  const textBlob = textItems.map((item) => item.text).join(" ");
  const bubbleWidthClass = mediaItems.length
    ? getMediaBubbleClass(mediaItems.length)
    : getTextBubbleClass(textBlob);
  const bubblePaddingClass = mediaItems.length ? "px-3 py-3" : "px-4 py-3";
  const gridCols = imageItems.length >= 3 ? 3 : imageItems.length;
  const thumbAspect = imageItems.length <= 4 ? "aspect-square h-20" : "aspect-[4/3] h-16";

  return (
    <div
      className={`w-fit rounded-nkc border text-sm leading-relaxed ${bubblePaddingClass} ${bubbleWidthClass} overflow-hidden ${
        isMine
          ? "ml-auto border-nkc-accent/40 bg-nkc-panelMuted text-nkc-text"
          : "border-nkc-border bg-nkc-panel text-nkc-text"
      }`}
    >
      {textItems.length ? (
        <div className="space-y-2">
          {textItems.map((item) => (
            <div key={item.id} className="whitespace-pre-wrap">
              {item.text}
            </div>
          ))}
        </div>
      ) : null}

      {imageItems.length ? (
        <div
          className={textItems.length ? "mt-3 grid gap-2" : "grid gap-2"}
          style={{ gridTemplateColumns: `repeat(${gridCols}, minmax(0, 1fr))` }}
        >
          {imageItems.map((item, index) => (
            <button
              key={item.id}
              type="button"
              onClick={() => onOpenMedia?.(imageItems, index)}
              className="relative"
            >
              {item.media ? <MediaThumb media={item.media} className={thumbAspect} /> : null}
            </button>
          ))}
        </div>
      ) : null}

      {fileItems.length ? (
        <div className={textItems.length || imageItems.length ? "mt-3 space-y-2" : "space-y-2"}>
          {fileItems.map((item) =>
            item.media ? <FileAttachmentRow key={item.id} media={item.media} /> : null
          )}
        </div>
      ) : null}

      {footer ? <div className="mt-2 flex items-center gap-1 text-[11px] text-nkc-muted">{footer}</div> : null}
    </div>
  );
}
