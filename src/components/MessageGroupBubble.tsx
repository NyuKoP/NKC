import { useAppStore } from "../app/store";
import { useEffect, useState, type ReactNode, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { FileText } from "lucide-react";
import type { MediaRef } from "../db/repo";
import { loadMessageMedia } from "../db/repo";
import { subscribeMessageMediaReady } from "../storage/mediaReady";
import { MediaTransferStatus } from "./MediaTransferStatus";
import { onAccountOwnerChange } from "../accounts/accountOwnerLifecycle";
import type { MessageGroup, MessageLike } from "../ui/groupMessages";

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
  highlightQuery?: string;
  onRequestMenu?: (event: ReactMouseEvent | ReactKeyboardEvent, item?: T) => void;
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

// Signal lets text wrap according to the available timeline width instead of
// changing the bubble at arbitrary character-count thresholds.
const textBubbleWidthClass =
  "max-w-[min(306px,calc(100vw-96px))] md:max-w-[370px] xl:max-w-[50vw]";

const mediaBubbleWidthClass = "w-[min(300px,calc(100vw-96px))]";

const isPreviewableMedia = (media: MediaRef) => media.mime.startsWith("image/");

type MediaThumbProps = {
  media: MediaRef;
  preview: boolean;
  className?: string;
};

const MediaThumb = ({ media, preview, className }: MediaThumbProps) => {
  const [loaded, setLoaded] = useState<{ media: MediaRef; url: string } | null>(null);
  const previewUrl = preview && loaded?.media === media ? loaded.url : null;
  const [readyVersion, setReadyVersion] = useState(0);
  const isImage = media.mime.startsWith("image/");
  const language = useAppStore(state => state.ui.language);

  useEffect(() => {
    if (!isImage || !preview) return;
    let active = true;
    let objectUrl: string | undefined;

    const stop = onAccountOwnerChange(() => {
      active = false;

      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = undefined;
      setLoaded(null);
    });

    const load = async () => {
      try {
        const nextBlob = await loadMessageMedia(media);

        if (!nextBlob || !active) return;
        objectUrl = URL.createObjectURL(nextBlob);
        setLoaded({ media, url: objectUrl });
      } catch (error) {
        console.error("Failed to load media thumb", error);
      }
    };

    void load();

    return () => {
      active = false;
      stop();

      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [isImage, media, preview, readyVersion]);

  useEffect(
    () =>
      subscribeMessageMediaReady((ownerId) => {
        if (ownerId === media.ownerId) setReadyVersion((value) => value + 1);
      }),
    [media.ownerId]
  );

  const baseClass = className ?? "aspect-square h-full w-full object-cover";
  const placeholderClass = className ? "aspect-square w-full" : baseClass;

  if (!isImage) {
    return <div className={`${placeholderClass} bg-nkc-surface`} />;
  }

  return previewUrl ? (
    <img
      src={previewUrl}
      alt={media.name}
      className={baseClass}
    />
  ) : (
    <div className={`${placeholderClass} flex items-center justify-center bg-nkc-surface p-3 text-xs text-nkc-muted`}>
      {language === "en" ? "Click to view photo" : "클릭하여 사진 보기"}
    </div>
  );
};

const FileAttachmentRow = ({ media }: { media: MediaRef }) => (
  <div className="flex items-center gap-2 text-xs">
    <FileText size={14} className="shrink-0 opacity-80" />
    <div className="min-w-0">
      <div className="line-clamp-1">{media.name}</div>
      <div className="text-[11px] opacity-80">{formatBytes(media.size)}</div>
    </div>
  </div>
);

export default function MessageGroupBubble<T extends ChatMessageLike>({
  group,
  isMine,
  onOpenMedia,
  footer,
  highlightQuery,
  onRequestMenu,
}: MessageGroupBubbleProps<T>) {
  const language = useAppStore((state) => state.ui.language);
  const textItems = group.items.filter((item) => item.kind === "text" && item.text);
  const mediaItems = group.items.filter((item) => item.kind === "media" && item.media);

  const imageItems = mediaItems.filter((item) =>
    item.media ? isPreviewableMedia(item.media) : false
  );

  const fileItems = mediaItems.filter((item) =>
    item.media ? !isPreviewableMedia(item.media) : false
  );

  const bubbleWidthClass = mediaItems.length
    ? mediaBubbleWidthClass
    : textBubbleWidthClass;

  const visibleImageItems = imageItems.slice(0, 5);
  const hiddenImageCount = Math.max(0, imageItems.length - visibleImageItems.length);
  const isPhotoOnly = imageItems.length > 0 && fileItems.length === 0;
  const highlight = highlightQuery?.trim();

  const getImageGridClass = () => {
    if (imageItems.length === 1) return "grid max-h-[400px] grid-cols-1";

    if (imageItems.length === 2) return "grid h-[150px] grid-cols-2";

    if (imageItems.length === 3) return "grid h-[200px] grid-cols-3 grid-rows-2";

    if (imageItems.length === 4) return "grid h-[300px] grid-cols-2 grid-rows-2";

    return "grid h-[250px] grid-cols-6 grid-rows-5";
  };

  const getImageCellClass = (index: number) => {
    if (imageItems.length === 1) return "flex max-h-[400px] items-center justify-center";

    if (imageItems.length === 3 && index === 0) return "col-span-2 row-span-2";

    if (imageItems.length >= 5) {
      return index < 2 ? "col-span-3 row-span-3" : "col-span-2 row-span-2";
    }

    return "";
  };

  const renderHighlightedText = (text: string) => {
    if (!highlight) return text;
    const lowerText = text.toLowerCase();
    const lowerQuery = highlight.toLowerCase();

    if (!lowerQuery) return text;
    const parts: ReactNode[] = [];
    let cursor = 0;

    while (cursor < text.length) {
      const idx = lowerText.indexOf(lowerQuery, cursor);

      if (idx === -1) {
        parts.push(text.slice(cursor));
        break;
      }

      if (idx > cursor) {
        parts.push(text.slice(cursor, idx));
      }

      parts.push(
        <span key={`${idx}-${cursor}`} className="rounded-sm bg-nkc-warningBg px-0.5">
          {text.slice(idx, idx + lowerQuery.length)}
        </span>
      );
      cursor = idx + lowerQuery.length;
    }

    return parts;
  };

  return (
    <div
      data-testid={mediaItems.length ? "media-message-bubble" : undefined}
      onContextMenu={(event) => {
        if (!onRequestMenu) return;
        event.preventDefault();
        onRequestMenu(event);
      }}
      className={`group relative w-fit overflow-hidden rounded-bubble text-sm leading-relaxed ${bubbleWidthClass} animate-signal-slide-up ${
        isMine
          ? "ml-auto bg-nkc-bubbleSent text-nkc-bubbleSentText"
          : "bg-nkc-bubbleRecv text-nkc-bubbleRecvText"
      }`}
    >
      {textItems.length ? (
        <div className="space-y-2 px-3 py-2">
          {textItems.map((item) => (
            <div key={item.id} data-msg-id={item.id} className="whitespace-pre-wrap">
              {renderHighlightedText(item.text)}
            </div>
          ))}
        </div>
      ) : null}

      {imageItems.length ? (
        <div
          data-testid="signal-image-grid"
          data-image-count={imageItems.length}
          className={`${getImageGridClass()} gap-px overflow-hidden bg-nkc-border ${
            textItems.length ? "border-t border-nkc-border" : ""
          }`}
        >
          {visibleImageItems.map((item, index) => (
            <button
              key={item.id}
              type="button"
              onClick={() => onOpenMedia?.(imageItems, index)}
              onContextMenu={(event) => {
                if (!onRequestMenu) return;
                event.preventDefault();
                event.stopPropagation();
                onRequestMenu(event, item);
              }}
              onKeyDown={(event) => {
                if (!onRequestMenu) return;

                if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
                event.preventDefault();
                event.stopPropagation();
                onRequestMenu(event, item);
              }}
              aria-haspopup="menu"
              aria-label={language === "en" ? `Open ${item.media?.name || "photo"}` : `${item.media?.name || "사진"} 열기`}
              className={`relative min-h-0 min-w-0 overflow-hidden bg-nkc-surface ${getImageCellClass(index)}`}
            >
              {item.media ? (
                <MediaThumb
                  media={item.media}
                  preview={isMine}
                  className={
                    imageItems.length === 1
                      ? "block h-auto max-h-[400px] max-w-full w-auto object-contain"
                      : undefined
                  }
                />
              ) : null}
              {hiddenImageCount > 0 && index === visibleImageItems.length - 1 ? (
                <span
                  data-testid="signal-image-grid-more"
                  className="absolute inset-0 flex items-center justify-center bg-black/55 text-2xl font-medium text-white"
                >
                  +{hiddenImageCount}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}

      {fileItems.length ? (
        <div className="space-y-2 px-3 py-2">
          {fileItems.map((item) =>
            item.media ? <FileAttachmentRow key={item.id} media={item.media} /> : null
          )}
        </div>
      ) : null}

      {isMine && mediaItems.length > 0 ? <MediaTransferStatus media={mediaItems.flatMap((item) => item.media ? [item.media] : [])} /> : null}

      {footer ? (
        <div className={`flex flex-nowrap items-center gap-1 whitespace-nowrap text-[11px] ${
          isPhotoOnly
            ? "mx-3 mb-2 mt-1.5 text-inherit"
            : `mx-3 mb-2 mt-1.5 ${isMine ? "text-nkc-bubbleMeta" : "text-nkc-muted"}`
        }`}>
          {footer}
        </div>
      ) : null}
    </div>
  );
}
