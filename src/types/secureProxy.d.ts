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
      install: (payload: { network: "tor" | "alternateRoute" }) => Promise<void>;
      uninstall: (payload: { network: "tor" | "alternateRoute" }) => Promise<void>;
      setMode: (payload: { enabled: boolean; network: "tor" | "alternateRoute" }) => Promise<void>;
      status: () => Promise<unknown>;
      checkUpdates: () => Promise<unknown>;
      applyUpdate: (payload: { network: "tor" | "alternateRoute" }) => Promise<void>;
      onProgress: (cb: (payload: unknown) => void) => () => void;
    };
  }
}
