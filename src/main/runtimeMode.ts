type RuntimeModeInput = {
  isPackaged: boolean;
  rendererUrl?: string;
};

export const shouldUseDevRuntime = ({ isPackaged, rendererUrl }: RuntimeModeInput) =>
  !isPackaged && Boolean(rendererUrl);
