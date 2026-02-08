export type FriendRoutePath = "onionRouter" | "selfOnion" | "directP2P";

export type FriendRouteTerminalStatus = "sent" | "failed";

export type FriendRoutePathSuccess = {
  ok: true;
  via: FriendRoutePath;
  details?: string;
};

export type FriendRoutePathFailure = {
  ok: false;
  code: string;
  details?: string;
};

export type FriendRoutePathResult = FriendRoutePathSuccess | FriendRoutePathFailure;

export type FriendRouteAttemptTerminal = {
  attempt_ended_at: number;
  terminal_status: FriendRouteTerminalStatus;
  terminal_error_code: string | null;
  details?: string;
};

type CodedError = Error & { code?: string };

const DEFAULT_DEADLINE_MS = 30_000;

const normalizeCode = (value: string) =>
  value
    .trim()
    .replace(/[^a-zA-Z0-9:_-]+/g, "_")
    .replace(/^_+|_+$/g, "");

const inferErrorCode = (error: unknown, fallback = "UNKNOWN_ERROR") => {
  if (error && typeof error === "object") {
    const code = (error as CodedError).code;
    if (typeof code === "string" && code.trim()) {
      return normalizeCode(code);
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  const prefixed = /^([A-Z0-9_:-]{3,})\b/.exec(message.trim());
  if (prefixed?.[1]) {
    return normalizeCode(prefixed[1]);
  }
  return normalizeCode(fallback);
};

export const createFinalizeAttemptOnce = (
  writeTerminal: (terminal: FriendRouteAttemptTerminal) => Promise<void> | void,
  now: () => number = () => Date.now()
) => {
  let finalizedPromise: Promise<FriendRouteAttemptTerminal> | null = null;
  return (
    terminal_status: FriendRouteTerminalStatus,
    terminal_error_code: string | null,
    details?: string
  ) => {
    if (finalizedPromise) return finalizedPromise;
    const payload: FriendRouteAttemptTerminal = {
      attempt_ended_at: now(),
      terminal_status,
      terminal_error_code,
      details,
    };
    finalizedPromise = Promise.resolve(writeTerminal(payload)).then(() => payload);
    return finalizedPromise;
  };
};

export type FriendRouteAttemptOptions = {
  deadlineMs?: number;
  now?: () => number;
  onAttemptStart?: (payload: { attempt_started_at: number }) => Promise<void> | void;
  onAttemptTerminal: (payload: FriendRouteAttemptTerminal) => Promise<void> | void;
  candidates: Array<{
    path: FriendRoutePath;
    run: (signal: AbortSignal) => Promise<FriendRoutePathResult>;
  }>;
};

export type FriendRouteAttemptResult = {
  attempt_started_at: number;
  attempt_ended_at: number;
  terminal_status: FriendRouteTerminalStatus;
  terminal_error_code: string | null;
  via?: FriendRoutePath;
  details?: string;
};

export const runFriendRouteAttempt = async (
  options: FriendRouteAttemptOptions
): Promise<FriendRouteAttemptResult> => {
  const now = options.now ?? (() => Date.now());
  const deadlineMs = Math.max(1, Math.round(options.deadlineMs ?? DEFAULT_DEADLINE_MS));
  const attempt_started_at = now();
  await options.onAttemptStart?.({ attempt_started_at });

  const abortController = new AbortController();
  const finalizeAttemptOnce = createFinalizeAttemptOnce(options.onAttemptTerminal, now);
  const terminalFromPayload = (
    terminal: FriendRouteAttemptTerminal,
    via?: FriendRoutePath
  ): FriendRouteAttemptResult => ({
    attempt_started_at,
    attempt_ended_at: terminal.attempt_ended_at,
    terminal_status: terminal.terminal_status,
    terminal_error_code: terminal.terminal_error_code,
    details: terminal.details,
    via,
  });

  if (options.candidates.length === 0) {
    const terminal = await finalizeAttemptOnce("failed", "NO_ROUTE_CANDIDATE", "No route candidates");
    return terminalFromPayload(terminal);
  }

  const failures: string[] = [];
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const terminalPromise = new Promise<FriendRouteAttemptResult>((resolve) => {
    const finish = async (
      status: FriendRouteTerminalStatus,
      code: string | null,
      details?: string,
      via?: FriendRoutePath
    ) => {
      const terminal = await finalizeAttemptOnce(status, code, details);
      if (!abortController.signal.aborted) {
        abortController.abort();
      }
      resolve(terminalFromPayload(terminal, via));
    };

    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void finish("failed", "DEADLINE_EXCEEDED", `Attempt deadline exceeded (${deadlineMs}ms)`);
    }, deadlineMs);

    let pending = options.candidates.length;
    for (const candidate of options.candidates) {
      void candidate
        .run(abortController.signal)
        .then((result) => {
          if (settled) return;
          if (result.ok) {
            settled = true;
            void finish("sent", null, result.details, result.via);
            return;
          }
          failures.push(`${candidate.path}:${result.code}`);
          pending -= 1;
          if (pending > 0) return;
          settled = true;
          const errorCode = normalizeCode(result.code || "ROUTE_FAILED");
          void finish("failed", errorCode, failures.join(" || "));
        })
        .catch((error) => {
          if (settled) return;
          failures.push(`${candidate.path}:${inferErrorCode(error, "ROUTE_EXCEPTION")}`);
          pending -= 1;
          if (pending > 0) return;
          settled = true;
          const code = inferErrorCode(error, "ROUTE_EXCEPTION");
          void finish("failed", code, failures.join(" || "));
        });
    }
  });

  try {
    return await terminalPromise;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};
