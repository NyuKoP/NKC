export const probeNetworkStages = ["admission", "connection", "proxy_connect", "socks_handshake", "socks_connect",
  "http_request", "http_request_body", "http_response", "http_response_headers", "http_body", "retry_wait", "unknown"] as const;

export const getProbeNetworkStage = (error: unknown): typeof probeNetworkStages[number] => {
  const detail = error instanceof Error ? error.message : typeof error === "string" ? error : "";

  return probeNetworkStages.find((stage) => detail.startsWith(`probe_stage_${stage}:`)) ?? "unknown";
};

export const torProbeErrorCodes = ["proxy_unreachable", "proxy_connect_timeout", "socks_handshake_timeout",
  "upstream_response_timeout", "socks_handshake_failed", "socks_reply_general_failure", "socks_reply_ruleset_denied",
  "socks_reply_network_unreachable", "socks_reply_host_unreachable", "socks_reply_connection_refused",
  "socks_reply_ttl_expired", "socks_reply_command_unsupported", "socks_reply_address_unsupported",
  "socks_reply_unknown", "native_worker_unavailable", "native_worker_exited", "native_worker_timeout",
  "native_transport_unavailable", "onion_descriptor_unavailable", "tor_network_unreachable", "onion_service_refused",
  "handshake_failed", "upstream_rate_limited", "permanent_upstream_rejection", "upstream_http_error", "upstream_error", "unknown"] as const;

export const getTorProbeErrorCode = (error: unknown): typeof torProbeErrorCodes[number] => {
  const detail = error instanceof Error ? error.message.toLowerCase() : typeof error === "string" ? error.toLowerCase() : "";

  return torProbeErrorCodes.find((code) => code !== "unknown" && detail.includes(code)) ?? "unknown";
};

/** Classify locally; only fixed categories/codes are written to cold-start traces. */
export const classifyTorProbeError = (error: unknown):
  "native_unavailable" | "connection_refused" | "proxy_error" | "socks_error" | "http_error" | "timeout" | "unknown" => {
  const detail = error instanceof Error ? error.message.toLowerCase() : typeof error === "string" ? error.toLowerCase() : "";

  if (/native_transport_unavailable|native_worker_unavailable|native_worker_exited/.test(detail)) return "native_unavailable";

  if (/socks_reply_connection_refused|econnrefused|connection refused/.test(detail)) return "connection_refused";

  if (/timeout|deadline exceeded|etimedout/.test(detail)) return "timeout";

  if (/proxy_unreachable|proxy_connect|proxy_error/.test(detail)) return "proxy_error";

  if (/socks_reply_|socks_handshake|socks_auth|socks_connect/.test(detail)) return "socks_error";

  if (/prewarm-http-\d{3}/.test(detail)) return "http_error";

  return "unknown";
};
