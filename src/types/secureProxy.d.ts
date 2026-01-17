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
  }
}
