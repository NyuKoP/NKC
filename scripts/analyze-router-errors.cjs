#!/usr/bin/env node
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");

const DEFAULT_APP_NAME = process.env.NKC_LOG_APP_NAME || "test";

const usage = () => {
  console.log(
    [
      "Usage:",
      "  node scripts/analyze-router-errors.cjs [options] [logPath ...]",
      "",
      "Options:",
      "  --limit <n>   Show up to n recent failures (default: 20)",
      "  --json        Print machine-readable JSON output",
      "  -h, --help    Show this help",
      "",
      "If no logPath is provided, platform default test logs are used.",
      "Use NKC_LOG_APP_NAME to override app directory name (default: test).",
    ].join("\n")
  );
};

const parseArgs = (argv) => {
  const out = {
    limit: 20,
    json: false,
    paths: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--json") {
      out.json = true;
      continue;
    }
    if (token === "--limit") {
      const next = argv[i + 1];
      if (!next || Number.isNaN(Number(next))) {
        throw new Error("--limit requires a numeric value");
      }
      out.limit = Math.max(1, Number.parseInt(next, 10));
      i += 1;
      continue;
    }
    if (token === "-h" || token === "--help") {
      out.help = true;
      continue;
    }
    out.paths.push(token);
  }
  return out;
};

const getDefaultLogPaths = () => {
  const platform = process.platform;
  let root;
  if (platform === "win32") {
    const appData = process.env.APPDATA;
    if (appData) {
      root = path.join(appData, DEFAULT_APP_NAME, "logs");
    }
  } else if (platform === "darwin") {
    root = path.join(
      os.homedir(),
      "Library",
      "Application Support",
      DEFAULT_APP_NAME,
      "logs"
    );
  } else {
    root = path.join(os.homedir(), ".config", DEFAULT_APP_NAME, "logs");
  }
  if (!root) return [];
  return [
    path.join(root, "nkc-test-friend-flow.log"),
    path.join(root, "nkc-test-events.log"),
  ];
};

const normalizeCode = (input) =>
  input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9:]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);

const extractCodesFromSegment = (segment) => {
  const codes = [];
  const trimmed = segment.trim();
  if (!trimmed) return codes;

  const routeMatch = /^([a-zA-Z0-9_]+)\s*:\s*(.+)$/.exec(trimmed);
  const routePrefix = routeMatch ? normalizeCode(routeMatch[1]) : null;
  const detail = routeMatch ? routeMatch[2].trim() : trimmed;

  const explicitCodes = [...detail.matchAll(/([a-z_]+:[a-z0-9_:-]+)/gi)].map((m) =>
    normalizeCode(m[1])
  );
  for (const code of explicitCodes) {
    if (!code) continue;
    if (routePrefix && !code.startsWith(`${routePrefix}:`)) {
      codes.push(`${routePrefix}:${code}`);
    } else {
      codes.push(code);
    }
  }

  if (/direct p2p data channel is not open/i.test(detail)) {
    codes.push(`${routePrefix ?? "directp2p"}:channel_not_open`);
  }
  if (/internal onion route is not ready/i.test(detail)) {
    codes.push(`${routePrefix ?? "selfonion"}:route_not_ready`);
  }
  if (/forward_failed:no_route/i.test(detail)) {
    codes.push(`${routePrefix ?? "onionrouter"}:forward_failed:no_route`);
  }
  if (/this operation was aborted/i.test(detail)) {
    codes.push(`${routePrefix ?? "router"}:aborted`);
  }
  if (/send failed/i.test(detail)) {
    codes.push(`${routePrefix ?? "router"}:send_failed`);
  }

  if (codes.length === 0) {
    const fallback = normalizeCode(detail);
    if (fallback) {
      codes.push(routePrefix ? `${routePrefix}:${fallback}` : fallback);
    }
  }

  return [...new Set(codes)];
};

const extractErrorCodes = (event) => {
  const codes = [];
  const errorSegments = [];

  if (typeof event?.error === "string" && event.error.trim()) {
    errorSegments.push(...event.error.split("||"));
  }
  if (typeof event?.errorDetail?.code === "string" && event.errorDetail.code.trim()) {
    codes.push(normalizeCode(event.errorDetail.code));
  }
  if (typeof event?.errorDetail?.message === "string" && event.errorDetail.message.trim()) {
    errorSegments.push(event.errorDetail.message);
  }

  for (const segment of errorSegments) {
    for (const code of extractCodesFromSegment(segment)) {
      codes.push(code);
    }
  }

  const via = typeof event?.via === "string" ? normalizeCode(event.via) : "";
  if (codes.length === 0 && via) {
    codes.push(`${via}:unknown_error`);
  }
  if (codes.length === 0) {
    codes.push("unknown_error");
  }
  return [...new Set(codes)];
};

const shortError = (event) => {
  if (typeof event?.error === "string" && event.error.trim()) return event.error.trim();
  if (typeof event?.errorDetail?.message === "string" && event.errorDetail.message.trim()) {
    return event.errorDetail.message.trim();
  }
  return "";
};

const safeIso = (value, fallback) => {
  if (typeof value !== "string" || !value) return fallback;
  const t = Date.parse(value);
  if (Number.isNaN(t)) return fallback;
  return new Date(t).toISOString();
};

const bump = (map, key) => {
  const k = key || "unknown";
  map.set(k, (map.get(k) ?? 0) + 1);
};

const mapToSortedPairs = (map) =>
  [...map.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0]);
  });

const asObject = (value) => (value && typeof value === "object" ? value : null);

const toStringArray = (value) => {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
};

const summarizeDiagnosticAttempts = (diagnostic) => {
  const asObj = asObject(diagnostic);
  if (!asObj) return "";
  const attempts = Array.isArray(asObj.attempts) ? asObj.attempts : [];
  if (!attempts.length) return "";
  return attempts
    .map((attempt) => {
      const obj = asObject(attempt) || {};
      const phase = typeof obj.phase === "string" ? obj.phase : "attempt";
      const transport = typeof obj.transport === "string" ? obj.transport : "unknown";
      const ok = obj.ok === true ? "ok" : "fail";
      const err =
        ok === "fail" && typeof obj.error === "string" && obj.error.trim()
          ? `(${obj.error.trim()})`
          : "";
      return `${phase}:${transport}:${ok}${err}`;
    })
    .join(" > ");
};

const buildTimelineKey = (event) => {
  if (event.operationId) return `op:${event.operationId}`;
  if (event.messageId) return `msg:${event.messageId}`;
  return `fallback:${event.convId || "unknown"}:${event.at}`;
};

const compareByTime = (a, b) => {
  if (a.at !== b.at) return a.at.localeCompare(b.at);
  return a.lineNo - b.lineNo;
};

const dedupeEventSignature = (event) =>
  [
    event.at,
    event.status,
    event.operationId || "",
    event.messageId || "",
    event.convId || "",
    event.via || "",
    event.checkpoint || "",
    event.error || "",
    event.failureClass || "",
  ].join("|");

const buildOperationTimelines = (events, limit) => {
  const sorted = [...events].sort(compareByTime);
  const byKey = new Map();
  const seen = new Set();

  for (const event of sorted) {
    const sig = dedupeEventSignature(event);
    if (seen.has(sig)) continue;
    seen.add(sig);

    const key = buildTimelineKey(event);
    const existing =
      byKey.get(key) ||
      {
        key,
        operationId: event.operationId,
        messageId: event.messageId,
        convId: event.convId,
        firstAt: event.at,
        latestAt: event.at,
        hasAttempt: false,
        hasSent: false,
        hasFailed: false,
        events: [],
      };

    existing.firstAt = existing.firstAt < event.at ? existing.firstAt : event.at;
    existing.latestAt = existing.latestAt > event.at ? existing.latestAt : event.at;
    existing.operationId = existing.operationId || event.operationId;
    existing.messageId = existing.messageId || event.messageId;
    existing.convId = existing.convId || event.convId;
    if (event.status === "attempt") existing.hasAttempt = true;
    if (event.status === "sent") existing.hasSent = true;
    if (event.status === "failed") existing.hasFailed = true;
    existing.events.push(event);
    byKey.set(key, existing);
  }

  const timelineList = [...byKey.values()]
    .map((item) => ({
      ...item,
      events: [...item.events].sort(compareByTime),
    }))
    .sort((a, b) => a.latestAt.localeCompare(b.latestAt));

  if (typeof limit === "number" && limit > 0) {
    return timelineList.slice(-limit);
  }

  return timelineList;
};

const parseFile = async (filePath, state) => {
  const input = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let lineNo = 0;

  for await (const line of rl) {
    lineNo += 1;
    const trimmed = line.trim();
    if (!trimmed) continue;
    state.totalLines += 1;

    let record;
    try {
      record = JSON.parse(trimmed);
    } catch {
      state.invalidJson += 1;
      continue;
    }
    state.parsedJson += 1;

    if (record?.channel !== "friend-route") continue;
    const event = record?.event;
    if (!event || typeof event !== "object") continue;
    state.friendRouteEvents += 1;

    const status = typeof event.status === "string" ? event.status : "unknown";
    bump(state.statusCounts, status);
    const contextObj = asObject(event.context);
    const contextErrorCodes = toStringArray(contextObj?.errorCodes);
    const extractedCodes = status === "failed" ? extractErrorCodes(event) : [];
    const allCodes = [...new Set([...contextErrorCodes, ...extractedCodes])];
    const checkpoint =
      typeof contextObj?.checkpoint === "string" && contextObj.checkpoint.trim()
        ? contextObj.checkpoint.trim()
        : undefined;
    const failureClass =
      typeof contextObj?.failureClass === "string" && contextObj.failureClass.trim()
        ? contextObj.failureClass.trim()
        : undefined;
    const routeEvent = {
      at: safeIso(record.at ?? event.timestamp, "1970-01-01T00:00:00.000Z"),
      filePath,
      lineNo,
      status,
      via: typeof event.via === "string" ? event.via : "unknown",
      frameType: typeof event.frameType === "string" ? event.frameType : "unknown",
      direction: typeof event.direction === "string" ? event.direction : "unknown",
      codes: allCodes,
      error: shortError(event),
      operationId: typeof event.operationId === "string" ? event.operationId : undefined,
      messageId: typeof event.messageId === "string" ? event.messageId : undefined,
      convId: typeof event.convId === "string" ? event.convId : undefined,
      checkpoint,
      failureClass,
      diagnosticAttemptSummary: summarizeDiagnosticAttempts(contextObj?.routerDiagnostic),
    };
    state.routeEvents.push(routeEvent);

    if (status !== "failed") continue;

    state.failedFriendRouteEvents += 1;
    const codes = allCodes.length ? allCodes : extractErrorCodes(event);
    for (const code of codes) bump(state.codeCounts, code);

    const via = routeEvent.via;
    const frameType = routeEvent.frameType;
    const direction = routeEvent.direction;
    bump(state.viaCounts, via);
    bump(state.frameTypeCounts, frameType);
    bump(state.directionCounts, direction);

    state.failures.push({
      at: routeEvent.at,
      filePath,
      lineNo,
      via,
      frameType,
      direction,
      codes,
      error: routeEvent.error,
      messageId: routeEvent.messageId,
      operationId: routeEvent.operationId,
      convId: routeEvent.convId,
      checkpoint: routeEvent.checkpoint,
      failureClass: routeEvent.failureClass,
      diagnosticAttemptSummary: routeEvent.diagnosticAttemptSummary,
    });
  }
};

const printHumanReadable = (state, options) => {
  const filesUsed = state.existingPaths.map((p) => path.resolve(p));
  const allTimelines = buildOperationTimelines(state.routeEvents);
  const failedTimelines = allTimelines
    .filter((timeline) => timeline.hasFailed)
    .slice(-options.limit);
  const timelines = allTimelines.slice(-options.limit);
  console.log("== Router Error Analysis ==");
  console.log(`files: ${filesUsed.length}`);
  for (const p of filesUsed) console.log(`  - ${p}`);
  if (state.missingPaths.length) {
    console.log(`missing: ${state.missingPaths.length}`);
    for (const p of state.missingPaths) console.log(`  - ${path.resolve(p)}`);
  }
  console.log("");
  console.log("Summary");
  console.log(`  lines scanned: ${state.totalLines}`);
  console.log(`  json parsed: ${state.parsedJson}`);
  console.log(`  invalid json: ${state.invalidJson}`);
  console.log(`  friend-route events: ${state.friendRouteEvents}`);
  console.log(`  failed friend-route: ${state.failedFriendRouteEvents}`);
  console.log("");

  const statusPairs = mapToSortedPairs(state.statusCounts);
  if (statusPairs.length) {
    console.log("Status counts");
    for (const [k, v] of statusPairs) console.log(`  ${k}: ${v}`);
    console.log("");
  }

  const codePairs = mapToSortedPairs(state.codeCounts);
  if (codePairs.length) {
    console.log("Error code counts");
    for (const [k, v] of codePairs) console.log(`  ${k}: ${v}`);
    console.log("");
  }

  const viaPairs = mapToSortedPairs(state.viaCounts);
  if (viaPairs.length) {
    console.log("Via counts (failed only)");
    for (const [k, v] of viaPairs) console.log(`  ${k}: ${v}`);
    console.log("");
  }

  const framePairs = mapToSortedPairs(state.frameTypeCounts);
  if (framePairs.length) {
    console.log("FrameType counts (failed only)");
    for (const [k, v] of framePairs) console.log(`  ${k}: ${v}`);
    console.log("");
  }

  const recent = [...state.failures]
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(-options.limit);
  if (recent.length) {
    console.log(`Recent failed routes (last ${recent.length})`);
    for (const item of recent) {
      const rel = path.basename(item.filePath);
      const err = item.error ? ` | ${item.error}` : "";
      const checkpoint = item.checkpoint ? ` checkpoint=${item.checkpoint}` : "";
      const failureClass = item.failureClass ? ` class=${item.failureClass}` : "";
      const attemptFlow = item.diagnosticAttemptSummary
        ? ` | attempts=${item.diagnosticAttemptSummary}`
        : "";
      console.log(
        `  ${item.at} | ${rel}:${item.lineNo} | via=${item.via} frame=${item.frameType}${checkpoint}${failureClass} codes=${item.codes.join(",")}${err}${attemptFlow}`
      );
    }
  } else {
    console.log("No failed friend-route events found.");
  }

  console.log("");
  if (failedTimelines.length) {
    console.log(`Recent failed operation timelines (last ${failedTimelines.length})`);
    for (const timeline of failedTimelines) {
      const outcome = timeline.hasFailed
        ? "failed"
        : timeline.hasSent
          ? "sent"
          : timeline.hasAttempt
            ? "attempt-only"
            : "unknown";
      const idLabel = timeline.operationId || timeline.messageId || timeline.key;
      const conv = timeline.convId ? ` conv=${timeline.convId}` : "";
      console.log(
        `  [${outcome}] ${timeline.latestAt} | id=${idLabel}${conv} | events=${timeline.events.length}`
      );
      for (const event of timeline.events) {
        const checkpoint = event.checkpoint ? ` checkpoint=${event.checkpoint}` : "";
        const failureClass = event.failureClass ? ` class=${event.failureClass}` : "";
        const codes = event.codes.length ? ` codes=${event.codes.join(",")}` : "";
        const error = event.error ? ` | ${event.error}` : "";
        const attempts = event.diagnosticAttemptSummary
          ? ` | attempts=${event.diagnosticAttemptSummary}`
          : "";
        console.log(
          `    - ${event.at} status=${event.status} via=${event.via} frame=${event.frameType}${checkpoint}${failureClass}${codes}${error}${attempts}`
        );
      }
    }
  } else {
    console.log("No failed operation timeline entries found.");
  }

  console.log("");
  if (timelines.length) {
    console.log(`Recent operation timelines (all statuses, last ${timelines.length})`);
    for (const timeline of timelines) {
      const outcome = timeline.hasFailed
        ? "failed"
        : timeline.hasSent
          ? "sent"
          : timeline.hasAttempt
            ? "attempt-only"
            : "unknown";
      const idLabel = timeline.operationId || timeline.messageId || timeline.key;
      const conv = timeline.convId ? ` conv=${timeline.convId}` : "";
      console.log(
        `  [${outcome}] ${timeline.latestAt} | id=${idLabel}${conv} | events=${timeline.events.length}`
      );
      for (const event of timeline.events) {
        const checkpoint = event.checkpoint ? ` checkpoint=${event.checkpoint}` : "";
        const failureClass = event.failureClass ? ` class=${event.failureClass}` : "";
        const codes = event.codes.length ? ` codes=${event.codes.join(",")}` : "";
        const error = event.error ? ` | ${event.error}` : "";
        const attempts = event.diagnosticAttemptSummary
          ? ` | attempts=${event.diagnosticAttemptSummary}`
          : "";
        console.log(
          `    - ${event.at} status=${event.status} via=${event.via} frame=${event.frameType}${checkpoint}${failureClass}${codes}${error}${attempts}`
        );
      }
    }
  } else {
    console.log("No operation timeline entries found.");
  }
};

const main = async () => {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[analyze-router-errors] ${(error && error.message) || String(error)}`);
    usage();
    process.exit(1);
  }

  if (options.help) {
    usage();
    return;
  }

  const candidatePaths = options.paths.length ? options.paths : getDefaultLogPaths();
  if (!candidatePaths.length) {
    console.error("[analyze-router-errors] no log paths provided and no platform default available");
    process.exit(1);
  }

  const state = {
    totalLines: 0,
    parsedJson: 0,
    invalidJson: 0,
    friendRouteEvents: 0,
    failedFriendRouteEvents: 0,
    codeCounts: new Map(),
    viaCounts: new Map(),
    frameTypeCounts: new Map(),
    directionCounts: new Map(),
    statusCounts: new Map(),
    failures: [],
    routeEvents: [],
    existingPaths: [],
    missingPaths: [],
  };

  for (const p of candidatePaths) {
    const full = path.resolve(p);
    if (!fs.existsSync(full)) {
      state.missingPaths.push(full);
      continue;
    }
    state.existingPaths.push(full);
    await parseFile(full, state);
  }

  if (options.json) {
    const allTimelines = buildOperationTimelines(state.routeEvents);
    const timelines = allTimelines.slice(-options.limit);
    const failedTimelines = allTimelines
      .filter((timeline) => timeline.hasFailed)
      .slice(-options.limit);
    const output = {
      files: state.existingPaths,
      missing: state.missingPaths,
      summary: {
        totalLines: state.totalLines,
        parsedJson: state.parsedJson,
        invalidJson: state.invalidJson,
        friendRouteEvents: state.friendRouteEvents,
        failedFriendRouteEvents: state.failedFriendRouteEvents,
      },
      counts: {
        status: Object.fromEntries(mapToSortedPairs(state.statusCounts)),
        codes: Object.fromEntries(mapToSortedPairs(state.codeCounts)),
        via: Object.fromEntries(mapToSortedPairs(state.viaCounts)),
        frameType: Object.fromEntries(mapToSortedPairs(state.frameTypeCounts)),
        direction: Object.fromEntries(mapToSortedPairs(state.directionCounts)),
      },
      recentFailures: [...state.failures]
        .sort((a, b) => a.at.localeCompare(b.at))
        .slice(-options.limit),
      recentFailedOperationTimelines: failedTimelines,
      recentOperationTimelines: timelines,
    };
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  printHumanReadable(state, options);
};

main().catch((error) => {
  console.error(`[analyze-router-errors] fatal: ${(error && error.stack) || String(error)}`);
  process.exit(1);
});
