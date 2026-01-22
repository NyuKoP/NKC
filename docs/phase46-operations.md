# Phase 4.6 Operations

This phase tightens polling behavior, transport state stability, and error reporting
without changing routing rules or legacy local delivery.

## Polling jitter and backoff
- Base poll interval is 1000ms with +/-15% jitter to avoid synchronized bursts.
- Consecutive failures back off exponentially: base=1000ms, factor=2, max=8000ms.
- First successful poll resets the backoff to the base interval.
- Stop cancels timers and aborts in-flight requests.

## Transport state stability
- Error streak thresholds remain: degraded at 3 failures, failed at 6.
- State transitions between connected and degraded are debounced to avoid flip-flop.
- A single recovery success moves degraded/failed back to connected once.

## Error taxonomy
Forwarding errors are normalized to:
- timeout
- proxy_unreachable
- handshake_failed
- upstream_error

## Operational notes
- Jitter/backoff reduces load spikes and keeps repeated failures from hammering proxies.
- Debounced state changes keep the UI and logs from oscillating on transient network noise.
- In-flight limits prevent resource exhaustion while keeping successful paths unchanged.
