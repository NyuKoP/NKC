import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Image as ImageIcon, RotateCw } from "lucide-react";
import { CloseIcon } from "./icons/Icons";

const VIEWPORT_SIZE = 360;

const OUTPUT_SIZE = 512;

type Point = { x: number; y: number };

type AvatarImageEditorDialogProps = {
  file: File;
  onCancel: () => void;
  onApply: (file: File) => void;
  t: (ko: string, en: string) => string;
};

const clampOffset = (
  point: Point,
  image: HTMLImageElement,
  rotation: number,
  zoom: number
): Point => {
  const sideways = rotation % 180 !== 0;
  const width = sideways ? image.naturalHeight : image.naturalWidth;
  const height = sideways ? image.naturalWidth : image.naturalHeight;
  const scale = Math.max(VIEWPORT_SIZE / width, VIEWPORT_SIZE / height) * zoom;
  const maxX = Math.max(0, (width * scale - VIEWPORT_SIZE) / 2);
  const maxY = Math.max(0, (height * scale - VIEWPORT_SIZE) / 2);

  return {
    x: Math.max(-maxX, Math.min(maxX, point.x)),
    y: Math.max(-maxY, Math.min(maxY, point.y)),
  };
};

const drawImage = (
  canvas: HTMLCanvasElement,
  image: HTMLImageElement,
  rotation: number,
  zoom: number,
  offset: Point,
  size: number
) => {
  const context = canvas.getContext("2d");

  if (!context) return;
  canvas.width = size;
  canvas.height = size;
  context.clearRect(0, 0, size, size);
  const sideways = rotation % 180 !== 0;
  const rotatedWidth = sideways ? image.naturalHeight : image.naturalWidth;
  const rotatedHeight = sideways ? image.naturalWidth : image.naturalHeight;
  const scale = Math.max(size / rotatedWidth, size / rotatedHeight) * zoom;
  const offsetScale = size / VIEWPORT_SIZE;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.translate(size / 2 + offset.x * offsetScale, size / 2 + offset.y * offsetScale);
  context.rotate((rotation * Math.PI) / 180);
  context.scale(scale, scale);
  context.drawImage(image, -image.naturalWidth / 2, -image.naturalHeight / 2);
};

export default function AvatarImageEditorDialog({
  file,
  onCancel,
  onApply,
  t,
}: AvatarImageEditorDialogProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const dragRef = useRef<{ pointerX: number; pointerY: number; offset: Point } | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [offset, setOffset] = useState<Point>({ x: 0, y: 0 });

  useEffect(() => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      imageRef.current = image;
      setReady(true);
    };

    image.onerror = () => setError(t("이미지를 불러올 수 없습니다.", "Could not load the image."));
    image.src = url;

    return () => {
      imageRef.current = null;
      URL.revokeObjectURL(url);
    };
  }, [file, t]);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const image = imageRef.current;

    if (!canvas || !image) return;
    drawImage(canvas, image, rotation, zoom, offset, VIEWPORT_SIZE);
  }, [offset, rotation, zoom]);

  useEffect(() => {
    if (ready) redraw();
  }, [ready, redraw]);

  const reset = () => {
    setZoom(1);
    setRotation(0);
    setOffset({ x: 0, y: 0 });
  };

  const apply = async () => {
    const image = imageRef.current;

    if (!image || busy) return;
    setBusy(true);
    setError("");

    try {
      const canvas = document.createElement("canvas");
      drawImage(canvas, image, rotation, zoom, offset, OUTPUT_SIZE);

      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Canvas export failed")), "image/png");
      });

      const stem = file.name.replace(/\.[^.]+$/, "") || "profile-photo";
      onApply(new File([blob], `${stem}.png`, { type: "image/png", lastModified: Date.now() }));
    } catch (applyError) {
      console.error("Failed to edit avatar image", applyError);
      setError(t("이미지 편집에 실패했습니다.", "Failed to edit the image."));
    } finally {
      setBusy(false);
    }
  };

  const handlePointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const image = imageRef.current;
    const drag = dragRef.current;

    if (!image || !drag) return;
    setOffset(clampOffset({
      x: drag.offset.x + event.clientX - drag.pointerX,
      y: drag.offset.y + event.clientY - drag.pointerY,
    }, image, rotation, zoom));
  };

  const handleCanvasKeyDown = (event: KeyboardEvent<HTMLCanvasElement>) => {
    const image = imageRef.current;

    if (!image) return;

    const directions = new Map<string, Point>([
      ["ArrowLeft", { x: -1, y: 0 }],
      ["ArrowRight", { x: 1, y: 0 }],
      ["ArrowUp", { x: 0, y: -1 }],
      ["ArrowDown", { x: 0, y: 1 }],
    ]);

    const direction = directions.get(event.key);

    if (!direction) return;
    event.preventDefault();
    const step = event.shiftKey ? 12 : 4;
    setOffset((current) => clampOffset({
      x: current.x + direction.x * step,
      y: current.y + direction.y * step,
    }, image, rotation, zoom));
  };

  return (
    <Dialog.Root open onOpenChange={(nextOpen) => { if (!nextOpen && !busy) onCancel(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[80] bg-black/65 backdrop-blur-[2px]" />
        <Dialog.Content
          data-testid="avatar-image-editor"
          className="fixed left-1/2 top-1/2 z-[81] w-[calc(100vw-32px)] max-w-[500px] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-nkc-divider bg-nkc-panel p-6 shadow-2xl outline-none"
        >
          <div className="flex items-center justify-between gap-4">
            <Dialog.Title className="text-xl font-bold text-nkc-text">
              {t("이미지 편집하기", "Edit image")}
            </Dialog.Title>
            <Dialog.Close
              type="button"
              disabled={busy}
              aria-label={t("닫기", "Close")}
              className="flex h-9 w-9 items-center justify-center rounded-full text-nkc-muted hover:bg-nkc-hover hover:text-nkc-text focus-visible:ring-2 focus-visible:ring-nkc-focusRing disabled:opacity-50"
            >
              <CloseIcon className="h-5 w-5" />
            </Dialog.Close>
          </div>

          <div className="mx-auto mt-4 w-full max-w-[360px] overflow-hidden">
            <div className="relative mx-auto aspect-square w-full max-w-[360px] overflow-hidden bg-black/15">
              <canvas
                ref={canvasRef}
                width={VIEWPORT_SIZE}
                height={VIEWPORT_SIZE}
                data-testid="avatar-editor-canvas"
                data-offset-x={offset.x}
                data-offset-y={offset.y}
                tabIndex={0}
                aria-label={t("프로필 이미지 위치 조정. 방향키로 이동하고 Shift 키를 함께 누르면 더 크게 이동합니다.", "Adjust profile image position. Use arrow keys to move; hold Shift for larger steps.")}
                className="h-full w-full touch-none cursor-move focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nkc-focusRing"
                onKeyDown={handleCanvasKeyDown}
                onPointerDown={(event) => {
                  event.currentTarget.setPointerCapture(event.pointerId);
                  dragRef.current = { pointerX: event.clientX, pointerY: event.clientY, offset };
                }}
                onPointerMove={handlePointerMove}
                onPointerUp={() => { dragRef.current = null; }}
                onPointerCancel={() => { dragRef.current = null; }}
              />
              <div className="pointer-events-none absolute inset-0 rounded-full border-4 border-white shadow-[0_0_0_999px_rgba(0,0,0,0.42)]" />
              {!ready && !error ? (
                <div className="absolute inset-0 flex items-center justify-center text-sm text-nkc-muted">
                  {t("이미지를 불러오는 중…", "Loading image…")}
                </div>
              ) : null}
            </div>
          </div>

          <div className="mt-5 flex items-center gap-3">
            <ImageIcon size={16} className="shrink-0 text-nkc-muted" />
            <input
              type="range"
              min="1"
              max="3"
              step="0.01"
              value={zoom}
              aria-label={t("이미지 확대", "Image zoom")}
              onChange={(event) => {
                const nextZoom = Number(event.target.value);
                setZoom(nextZoom);
                const image = imageRef.current;

                if (image) setOffset((current) => clampOffset(current, image, rotation, nextZoom));
              }}
              className="min-w-0 flex-1 accent-nkc-accent"
            />
            <button
              type="button"
              onClick={() => {
                setRotation((current) => (current + 90) % 360);
                setOffset({ x: 0, y: 0 });
              }}
              aria-label={t("오른쪽으로 회전", "Rotate right")}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-nkc-muted hover:bg-nkc-hover hover:text-nkc-text focus-visible:ring-2 focus-visible:ring-nkc-focusRing"
            >
              <RotateCw size={18} />
            </button>
          </div>

          {error ? <p role="alert" className="mt-3 text-sm text-nkc-danger">{error}</p> : null}

          <div className="mt-6 flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={reset}
              disabled={busy}
              className="rounded-lg px-3 py-2.5 text-sm font-medium text-nkc-brandPrimary hover:bg-nkc-hover focus-visible:ring-2 focus-visible:ring-nkc-focusRing disabled:opacity-50"
            >
              {t("재설정", "Reset")}
            </button>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onCancel}
                disabled={busy}
                className="rounded-lg px-4 py-2.5 text-sm font-semibold text-nkc-text hover:bg-nkc-hover focus-visible:ring-2 focus-visible:ring-nkc-focusRing disabled:opacity-50"
              >
                {t("취소", "Cancel")}
              </button>
              <button
                type="button"
                onClick={() => void apply()}
                disabled={!ready || busy}
                className="rounded-lg bg-nkc-accent px-5 py-2.5 text-sm font-semibold text-nkc-accentText hover:brightness-110 focus-visible:ring-2 focus-visible:ring-nkc-focusRing disabled:opacity-50"
              >
                {busy ? t("적용 중…", "Applying…") : t("적용하기", "Apply")}
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
