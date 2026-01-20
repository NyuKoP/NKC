export type GroupCreatePayload = {
  id: string;
  name: string;
  memberIds: string[];
};

export const syncGroupCreate = async (_payload: GroupCreatePayload) => {
  void _payload;
  // TODO: wire network sync.
};
