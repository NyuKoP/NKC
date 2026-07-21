export type TrustedIpcEvent = Electron.IpcMainInvokeEvent | Electron.IpcMainEvent;

export type AssertTrustedIpcSender = (event: TrustedIpcEvent) => void;
export type IsTrustedIpcSender = (event: TrustedIpcEvent) => boolean;
