import { useCallback, useEffect, useMemo, useState } from "react";
import type { Conversation } from "../../db/repo";
import { getGroupAvatarOverride } from "../../security/preferences";
import { listFriendAliases } from "../../storage/friendStore";
import { parseAvatarRef, resolveGroupAvatarRef } from "../../utils/avatarRefs";

type UseProfileDecorationsArgs = {
  convs: Conversation[];
};

export const useProfileDecorations = ({ convs }: UseProfileDecorationsArgs) => {
  const [groupAvatarOverrides, setGroupAvatarOverrides] = useState<Record<string, string | null>>(
    {}
  );
  const [groupAvatarOverrideVersion, setGroupAvatarOverrideVersion] = useState(0);
  const [friendAliasesById, setFriendAliasesById] = useState<Record<string, string | undefined>>(
    {}
  );
  const [friendAliasVersion, setFriendAliasVersion] = useState(0);

  useEffect(() => {
    let active = true;
    const load = async () => {
      const groupConvs = convs.filter(
        (conv) => conv.type === "group" || conv.participants.length > 2
      );
      if (!groupConvs.length) {
        if (active) setGroupAvatarOverrides({});
        return;
      }
      const entries = await Promise.all(
        groupConvs.map(async (conv) => [conv.id, await getGroupAvatarOverride(conv.id)] as const)
      );
      if (!active) return;
      setGroupAvatarOverrides(Object.fromEntries(entries));
    };
    void load();
    return () => {
      active = false;
    };
  }, [convs, groupAvatarOverrideVersion]);

  useEffect(() => {
    let active = true;
    const load = async () => {
      const map = await listFriendAliases();
      if (!active) return;
      setFriendAliasesById(map);
    };
    void load();
    return () => {
      active = false;
    };
  }, [friendAliasVersion]);

  const groupAvatarRefsByConv = useMemo(() => {
    const map: Record<string, ReturnType<typeof parseAvatarRef>> = {};
    convs.forEach((conv) => {
      const resolved = resolveGroupAvatarRef(conv, groupAvatarOverrides[conv.id]);
      if (resolved) {
        map[conv.id] = resolved;
      }
    });
    return map;
  }, [convs, groupAvatarOverrides]);

  const refreshGroupAvatarOverrides = useCallback(() => {
    setGroupAvatarOverrideVersion((prev) => prev + 1);
  }, []);

  const refreshFriendAliases = useCallback(() => {
    setFriendAliasVersion((prev) => prev + 1);
  }, []);

  const setFriendAliasInState = useCallback((friendId: string, alias: string | null) => {
    const nextAlias = alias?.trim() ?? "";
    setFriendAliasesById((prev) => {
      if (!nextAlias) {
        const rest = { ...prev };
        delete rest[friendId];
        return rest;
      }
      return { ...prev, [friendId]: nextAlias };
    });
  }, []);

  return {
    groupAvatarOverrides,
    friendAliasesById,
    groupAvatarRefsByConv,
    refreshGroupAvatarOverrides,
    refreshFriendAliases,
    setFriendAliasInState,
  };
};
