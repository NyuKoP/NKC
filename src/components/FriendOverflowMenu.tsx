import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { MoreHorizontal, Star, StarOff, User } from "lucide-react";
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
}: FriendOverflowMenuProps) {
  const [open, setOpen] = useState(false);
  // Avoid double-toggles when click/select fire for the same item.
  const skipNextSelectRef = useRef(false);
  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button className="flex h-8 w-8 items-center justify-center rounded-full text-nkc-muted hover:bg-nkc-panelMuted hover:text-nkc-text" data-stop-row-click="true" data-testid={`friend-menu-${friendId}`} onClick={(event) => { event.stopPropagation(); }}>
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
            채팅
          </DropdownMenu.Item>
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
            프로필 보기
          </DropdownMenu.Item>
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
            {isFavorite ? "즐겨찾기 해제" : "즐겨찾기"}
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
            숨기기
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
            차단
          </DropdownMenu.Item>
          <DropdownMenu.Item
            onSelect={(event) => {
              event.stopPropagation();
              onDelete();
              setOpen(false);
            }}
            data-stop-row-click="true"
            className="cursor-pointer rounded-nkc px-3 py-2 text-red-400 outline-none hover:bg-red-500/10"
          >
            삭제
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
