import path from "node:path";
import { fileURLToPath } from "node:url";

type RendererTrustOptions = {
  isDev: boolean;
  isPackaged: boolean;
  rendererUrl?: string;
  distIndexPath: string;
};

type FrameLike = {
  url?: string;
  parent?: FrameLike | null;
};

type IpcSenderUrlOptions = {
  senderFrame?: FrameLike | null;
  senderUrl: string;
};

export const isTrustedRendererUrlForRuntime = (
  url: string,
  options: RendererTrustOptions
) => {
  if (!url) return false;

  try {
    const parsed = new URL(url);

    if (parsed.protocol === "file:") {
      if (options.isPackaged) return false;

      return path.resolve(fileURLToPath(parsed)) === path.resolve(options.distIndexPath);
    }

    if (!options.isDev && parsed.protocol === "nkc-app:") {
      return (
        parsed.host === "bundle" &&
        (parsed.pathname === "/" || parsed.pathname === "/index.html")
      );
    }

    if (!options.isDev || !options.rendererUrl) return false;

    return parsed.origin === new URL(options.rendererUrl).origin;
  } catch {
    return false;
  }
};

export const resolveTrustedMainFrameUrl = ({
  senderFrame,
  senderUrl,
}: IpcSenderUrlOptions) => {
  if (senderFrame?.parent) return null;

  return senderFrame?.url?.trim() || senderUrl.trim() || null;
};
