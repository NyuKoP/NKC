import { useAppStore } from "../app/store";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { MoreHorizontal } from "lucide-react";
import { useRef, useState } from "react";

type OverflowMenuProps = {
  conversationId: string;
  onHide: () => void;
  onDelete: () => void;
  onBlock: () => void;
  onMute: () => void;
  onTogglePin: () => void;
  muted: boolean;
  pinned: boolean;
};

export default function OverflowMenu({
  conversationId,
  onHide,
  onDelete,
  onBlock,
  onMute,
  onTogglePin,
  muted,
  pinned,
}: OverflowMenuProps) {
  const language = useAppStore((state) => state.ui.language);
  const t = (ko: string, en: string) => language === "ko" ? ko : en;
  const [open, setOpen] = useState(false);
  // Avoid double-toggles when click/select fire for the same item.
  const skipNextSelectRef = useRef(false);
  const muteLabel = muted ? t("음소거 해제", "Unmute") : t("음소거", "Mute");
  const pinLabel = pinned ? t("고정 해제", "Unpin") : t("고정", "Pin");

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button aria-label={t("더 보기", "More options")} className="flex h-8 w-8 items-center justify-center rounded-full text-nkc-muted hover:bg-nkc-panelMuted hover:text-nkc-text" data-stop-row-click="true" data-testid={`conversation-menu-${conversationId}`} onClick={(event) => { event.stopPropagation(); }}>
          <MoreHorizontal size={16} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          className="min-w-[160px] rounded-nkc border border-nkc-border bg-nkc-panel p-2 text-sm shadow-soft"
        >
          <DropdownMenu.Item
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              skipNextSelectRef.current = true;
              onTogglePin();
              setOpen(false);
              setTimeout(() => {
                skipNextSelectRef.current = false;
              }, 0);
            }}
            onSelect={(event) => {
              if (skipNextSelectRef.current) {
                event.stopPropagation();

                return;
              }

              event.stopPropagation();
              onTogglePin();
              setOpen(false);
            }}
            data-stop-row-click="true"
            data-testid={`conversation-favorite-${conversationId}`}
            aria-pressed={pinned ? "true" : "false"}
            className="cursor-pointer rounded-nkc px-3 py-2 text-nkc-text outline-none hover:bg-nkc-panelMuted"
          >
            {pinLabel}
          </DropdownMenu.Item>
          <DropdownMenu.Item
            onSelect={(event) => {
              event.stopPropagation();
              onHide();
              setOpen(false);
            }}
            data-stop-row-click="true"
            className="cursor-pointer rounded-nkc px-3 py-2 text-nkc-text outline-none hover:bg-nkc-panelMuted"
          >
            {t("숨기기", "Hide")}</DropdownMenu.Item>
          <DropdownMenu.Item
            onSelect={(event) => {
              event.stopPropagation();
              onMute();
              setOpen(false);
            }}
            data-stop-row-click="true"
            className="cursor-pointer rounded-nkc px-3 py-2 text-nkc-text outline-none hover:bg-nkc-panelMuted"
          >
            {muteLabel}
          </DropdownMenu.Item>
          <DropdownMenu.Item
            onSelect={(event) => {
              event.stopPropagation();
              onBlock();
              setOpen(false);
            }}
            data-stop-row-click="true"
            className="cursor-pointer rounded-nkc px-3 py-2 text-nkc-text outline-none hover:bg-nkc-panelMuted"
          >
            {t("차단", "Block")}</DropdownMenu.Item>
          <DropdownMenu.Item
            onSelect={(event) => {
              event.stopPropagation();
              onDelete();
              setOpen(false);
            }}
            data-stop-row-click="true"
            className="cursor-pointer rounded-nkc px-3 py-2 text-nkc-danger outline-none hover:bg-nkc-dangerBg"
          >
            {t("삭제", "Delete")}</DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
