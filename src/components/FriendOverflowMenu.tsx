import { useAppStore } from "../app/store";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Edit3, MoreHorizontal, Star, StarOff, User } from "lucide-react";
import { useRef, useState } from "react";

type FriendOverflowMenuProps = {
  friendId: string;
  isFavorite?: boolean;
  onChat: () => void;
  onViewProfile: () => void;
  onToggleFavorite: () => void;
  onHide: () => void;
  onDelete: () => void;
  onBlock: () => void;
  onRenameAlias: () => void;
};

export default function FriendOverflowMenu({
  friendId,
  isFavorite,
  onChat,
  onViewProfile,
  onToggleFavorite,
  onHide,
  onDelete,
  onBlock,
  onRenameAlias,
}: FriendOverflowMenuProps) {
  const language = useAppStore((state) => state.ui.language);
  const t = (ko: string, en: string) => language === "ko" ? ko : en;
  const [open, setOpen] = useState(false);
  // Avoid double-toggles when click/select fire for the same item.
  const skipNextSelectRef = useRef(false);

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button aria-label={t("더 보기", "More options")} className="flex h-8 w-8 items-center justify-center rounded-full text-nkc-muted hover:bg-nkc-panelMuted hover:text-nkc-text" data-stop-row-click="true" data-testid={`friend-menu-${friendId}`} onClick={(event) => { event.stopPropagation(); }}>
          <MoreHorizontal size={16} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          className="min-w-[160px] rounded-nkc border border-nkc-border bg-nkc-panel p-2 text-sm shadow-soft"
        >
          <DropdownMenu.Item
            onSelect={(event) => {
              event.stopPropagation();
              onChat();
              setOpen(false);
            }}
            data-stop-row-click="true"
            className="cursor-pointer rounded-nkc px-3 py-2 text-nkc-text outline-none hover:bg-nkc-panelMuted"
          >
            {t("채팅", "Chat")}</DropdownMenu.Item>
          <DropdownMenu.Item
            onSelect={(event) => {
              event.stopPropagation();
              onViewProfile();
              setOpen(false);
            }}
            data-stop-row-click="true"
            className="flex cursor-pointer items-center gap-2 rounded-nkc px-3 py-2 text-nkc-text outline-none hover:bg-nkc-panelMuted"
          >
            <User size={14} />
            {t("프로필 보기", "View profile")}</DropdownMenu.Item>
          <DropdownMenu.Item
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              skipNextSelectRef.current = true;
              onToggleFavorite();
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
              onToggleFavorite();
              setOpen(false);
            }}
            data-stop-row-click="true"
            data-testid={`friend-favorite-${friendId}`}
            aria-pressed={isFavorite ? "true" : "false"}
            className="flex cursor-pointer items-center gap-2 rounded-nkc px-3 py-2 text-nkc-text outline-none hover:bg-nkc-panelMuted"
          >
            {isFavorite ? <StarOff size={14} /> : <Star size={14} />}
            {isFavorite ? t("즐겨찾기 해제", "Remove favorite") : t("즐겨찾기", "Favorite")}
          </DropdownMenu.Item>
          <DropdownMenu.Item
            onSelect={(event) => {
              event.stopPropagation();
              onRenameAlias();
              setOpen(false);
            }}
            data-stop-row-click="true"
            className="flex cursor-pointer items-center gap-2 rounded-nkc px-3 py-2 text-nkc-text outline-none hover:bg-nkc-panelMuted"
          >
            <Edit3 size={14} />
            {t("이름 바꾸기(나만)", "Rename (only me)")}</DropdownMenu.Item>
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
