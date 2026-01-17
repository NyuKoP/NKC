import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { MoreHorizontal } from "lucide-react";

type OverflowMenuProps = {
  onHide: () => void;
  onDelete: () => void;
  onBlock: () => void;
  onMute: () => void;
  onTogglePin: () => void;
  muted: boolean;
  pinned: boolean;
};

export default function OverflowMenu({
  onHide,
  onDelete,
  onBlock,
  onMute,
  onTogglePin,
  muted,
  pinned,
}: OverflowMenuProps) {
  const muteLabel = muted ? "음소거 해제" : "음소거";
  const pinLabel = pinned ? "고정 해제" : "고정";

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
            onSelect={onTogglePin}
            className="cursor-pointer rounded-nkc px-3 py-2 text-nkc-text outline-none hover:bg-nkc-panelMuted"
          >
            {pinLabel}
          </DropdownMenu.Item>
          <DropdownMenu.Item
            onSelect={onHide}
            className="cursor-pointer rounded-nkc px-3 py-2 text-nkc-text outline-none hover:bg-nkc-panelMuted"
          >
            숨기기
          </DropdownMenu.Item>
          <DropdownMenu.Item
            onSelect={onMute}
            className="cursor-pointer rounded-nkc px-3 py-2 text-nkc-text outline-none hover:bg-nkc-panelMuted"
          >
            {muteLabel}
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
