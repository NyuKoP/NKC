/** Local IPC authority only. Never serialize this handle into a transport packet. */
export type MainAccountSession = Readonly<{
  accountId: string;
  generation: number;
  token: string;
}>;
