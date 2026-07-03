export {};

declare global {
  interface Window {
    electron?: {
      secureStorage: {
        isAvailable: () => Promise<boolean>;
        get: (key: string) => Promise<string | null>;
        set: (key: string, value: string) => Promise<boolean>;
        remove: (key: string) => Promise<boolean>;
      };
    };
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
    prefs?: {
      get: () => Promise<unknown>;
      set: (patch: unknown) => Promise<unknown>;
    };
    appControls?: {
      show: () => Promise<void>;
      hide: () => Promise<void>;
      quit: () => Promise<void>;
      syncNow: () => Promise<void>;
      reportSyncResult: (payload: {
        requestId: string;
        ok: boolean;
        error?: string;
      }) => void;
      onSyncRun: (
        cb: (payload: { requestId: string; reason: "manual" | "interval" }) => void
      ) => () => void;
      onSyncStatus: (cb: (payload: unknown) => void) => () => void;
      onBackgroundStatus: (cb: (payload: unknown) => void) => () => void;
    };
    testLog?: {
      append: (payload: { channel: string; event: unknown; at?: string }) => Promise<{
        ok: boolean;
        path: string;
      }>;
      getPath: () => Promise<string>;
      getFriendFlowPath: () => Promise<string>;
    };
  }
}
