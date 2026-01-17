import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { MoreHorizontal, Star, StarOff, User } from "lucide-react";

type FriendOverflowMenuProps = {
  isFavorite?: boolean;
  onChat: () => void;
  onViewProfile: () => void;
  onToggleFavorite: () => void;
  onHide: () => void;
  onDelete: () => void;
  onBlock: () => void;
};

export default function FriendOverflowMenu({
  isFavorite,
  onChat,
  onViewProfile,
  onToggleFavorite,
  onHide,
  onDelete,
  onBlock,
}: FriendOverflowMenuProps) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button className="flex h-8 w-8 items-center justify-center rounded-full text-nkc-muted hover:bg-nkc-panelMuted hover:text-nkc-text">
          <MoreHorizontal size={16} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          className="min-w-[160px] rounded-nkc border border-nkc-border bg-nkc-panel p-2 text-sm shadow-soft"
        >
          <DropdownMenu.Item
            onSelect={onChat}
            className="cursor-pointer rounded-nkc px-3 py-2 text-nkc-text outline-none hover:bg-nkc-panelMuted"
          >
            채팅
          </DropdownMenu.Item>
          <DropdownMenu.Item
            onSelect={onViewProfile}
            className="flex cursor-pointer items-center gap-2 rounded-nkc px-3 py-2 text-nkc-text outline-none hover:bg-nkc-panelMuted"
          >
            <User size={14} />
            프로필 보기
          </DropdownMenu.Item>
          <DropdownMenu.Item
            onSelect={onToggleFavorite}
            className="flex cursor-pointer items-center gap-2 rounded-nkc px-3 py-2 text-nkc-text outline-none hover:bg-nkc-panelMuted"
          >
            {isFavorite ? <StarOff size={14} /> : <Star size={14} />}
            {isFavorite ? "즐겨찾기 해제" : "즐겨찾기"}
          </DropdownMenu.Item>
          <DropdownMenu.Item
            onSelect={onHide}
            className="cursor-pointer rounded-nkc px-3 py-2 text-nkc-text outline-none hover:bg-nkc-panelMuted"
          >
            숨기기
          </DropdownMenu.Item>
          <DropdownMenu.Item
            onSelect={onBlock}
            className="cursor-pointer rounded-nkc px-3 py-2 text-nkc-text outline-none hover:bg-nkc-panelMuted"
          >
            차단
          </DropdownMenu.Item>
          <DropdownMenu.Item
            onSelect={onDelete}
            className="cursor-pointer rounded-nkc px-3 py-2 text-red-400 outline-none hover:bg-red-500/10"
          >
            삭제
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
