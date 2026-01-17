export {};

declare global {
  interface Window {
    secureProxy?: {
      applyProxy: (payload: {
        proxyUrl: string;
        enabled: boolean;
        allowRemote: boolean;
      }) => Promise<void>;
      checkProxy: () => Promise<{ ok: boolean; message: string }>;
    };
    onion?: {
      install: (payload: { network: "tor" | "lokinet" }) => Promise<void>;
      uninstall: (payload: { network: "tor" | "lokinet" }) => Promise<void>;
      setMode: (payload: { enabled: boolean; network: "tor" | "lokinet" }) => Promise<void>;
      status: () => Promise<unknown>;
      checkUpdates: () => Promise<unknown>;
      applyUpdate: (payload: { network: "tor" | "lokinet" }) => Promise<void>;
      onProgress: (cb: (payload: unknown) => void) => () => void;
    };
  }
}
