export type TorFriendCodeRuntime = {
  torState: string | null;
};

export type TorFriendCodeRoute = {
  onionAddr?: string;
};

export const isTorFriendCodeReady = (
  runtime: TorFriendCodeRuntime,
  route: TorFriendCodeRoute
) => runtime.torState === "running" && Boolean(route.onionAddr?.trim());
