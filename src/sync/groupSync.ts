export type GroupCreatePayload = {
  id: string;
  name: string;
  memberIds: string[];
};

export const syncGroupCreate = async (_payload: GroupCreatePayload) => {
  // TODO: wire network sync.
};
