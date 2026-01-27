import { useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import type { UserProfile } from "../db/repo";
import Avatar from "./Avatar";

type GroupInviteDialogProps = {
  open: boolean;
  friends: UserProfile[];
  existingMemberIds: string[];
  onOpenChange: (open: boolean) => void;
  onSubmit: (memberIds: string[]) => Promise<{ ok: boolean; error?: string }>;
};

const isEligibleFriend = (friend: UserProfile) =>
  friend.friendStatus !== "hidden" && friend.friendStatus !== "blocked";

export default function GroupInviteDialog({
  open,
  friends,
  existingMemberIds,
  onOpenChange,
  onSubmit,
}: GroupInviteDialogProps) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      setSearch("");
      setSelected(new Set());
      setError("");
      setBusy(false);
    }
  }, [open]);

  const existingSet = useMemo(() => new Set(existingMemberIds), [existingMemberIds]);

  const visibleFriends = useMemo(() => {
    const term = search.trim().toLowerCase();
    return friends
      .filter(isEligibleFriend)
      .filter((friend) => !existingSet.has(friend.id))
      .filter((friend) =>
        term ? friend.displayName.toLowerCase().includes(term) : true
      );
  }, [existingSet, friends, search]);

  const toggleMember = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleInvite = async () => {
    setError("");
    if (selected.size === 0) {
      setError("Select at least one friend.");
      return;
    }
    setBusy(true);
    try {
      const result = await onSubmit(Array.from(selected));
      if (!result.ok) {
        setError(result.error || "Failed to invite members.");
        return;
      }
      onOpenChange(false);
    } catch (inviteError) {
      console.error("Group invite failed", inviteError);
      setError("Failed to invite members.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60" />
        <Dialog.Content className="fixed left-1/2 top-1/2 w-[92vw] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-nkc border border-nkc-border bg-nkc-panel p-6 shadow-soft">
          <Dialog.Title className="text-base font-semibold text-nkc-text">
            Invite members
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-nkc-muted">
            Pick friends to add to this group.
          </Dialog.Description>

          <div className="mt-4 grid gap-3">
            <label className="text-sm">
              Search friends
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="mt-2 w-full rounded-nkc border border-nkc-border bg-nkc-panel px-3 py-2"
                placeholder="Type a name"
              />
            </label>

            <div className="max-h-56 space-y-2 overflow-y-auto rounded-nkc border border-nkc-border bg-nkc-panel p-2 text-sm">
              {visibleFriends.length ? (
                visibleFriends.map((friend) => (
                  <label
                    key={friend.id}
                    className="flex items-center gap-3 rounded-nkc px-2 py-2 hover:bg-nkc-panelMuted"
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(friend.id)}
                      onChange={() => toggleMember(friend.id)}
                    />
                    <Avatar
                      name={friend.displayName}
                      avatarRef={friend.avatarRef}
                      size={32}
                    />
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-nkc-text line-clamp-1">
                        {friend.displayName}
                      </div>
                      <div className="text-xs text-nkc-muted line-clamp-1">
                        {friend.status}
                      </div>
                    </div>
                  </label>
                ))
              ) : (
                <div className="rounded-nkc border border-dashed border-nkc-border px-3 py-3 text-xs text-nkc-muted">
                  No friends available to invite.
                </div>
              )}
            </div>
          </div>

          {error ? <div className="mt-3 text-xs text-red-300">{error}</div> : null}

          <div className="mt-5 flex justify-end gap-2">
            <Dialog.Close asChild>
              <button className="rounded-nkc border border-nkc-border px-4 py-2 text-sm text-nkc-text hover:bg-nkc-panelMuted">
                Close
              </button>
            </Dialog.Close>
            <button
              onClick={handleInvite}
              className="rounded-nkc bg-nkc-accent px-4 py-2 text-sm font-semibold text-nkc-bg disabled:cursor-not-allowed disabled:opacity-50"
              disabled={selected.size === 0 || busy}
            >
              Invite
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

