import type { NetConfig } from "./netConfig";

type SendEvent = "ack" | "send_fail";

export class RouteController {
  private ackRtts: number[] = [];
  private sendHistory: SendEvent[] = [];
  private routeBuildFailStreak = 0;
  private relayPoolSize = 0;
  private p95OverSince: number | null = null;
  private fallbackUntil = 0;

  decideTransport(config: NetConfig): "selfOnion" | "onionRouter" | "directP2P" {
    if (config.mode === "directP2P") return "directP2P";
    if (config.mode === "onionRouter") return "onionRouter";
    if (config.mode === "selfOnion") return "selfOnion";

    if (!config.selfOnionEnabled) return "onionRouter";
    const now = Date.now();
    if (this.fallbackUntil > now) return "onionRouter";
    if (this.shouldFallback(config, now)) {
      this.fallbackUntil = now + 2 * 60 * 1000;
      return "onionRouter";
    }
    return "selfOnion";
  }

  reportAck(_messageId: string, rttMs: number) {
    this.routeBuildFailStreak = 0;
    this.trackRtt(rttMs);
    this.trackSendEvent("ack");
  }

  reportSendFail(_kind: string) {
    this.trackSendEvent("send_fail");
  }

  reportRouteBuildFail() {
    this.routeBuildFailStreak += 1;
  }

  reportRelayPoolSize(n: number) {
    this.relayPoolSize = n;
  }

  private trackRtt(rttMs: number) {
    this.ackRtts.push(rttMs);
    if (this.ackRtts.length > 200) {
      this.ackRtts.shift();
    }
  }

  private trackSendEvent(kind: SendEvent) {
    this.sendHistory.push(kind);
    if (this.sendHistory.length > 20) {
      this.sendHistory.shift();
    }
  }

  private getP95(): number | null {
    if (!this.ackRtts.length) return null;
    const sorted = [...this.ackRtts].sort((a, b) => a - b);
    const idx = Math.floor(sorted.length * 0.95) - 1;
    return sorted[Math.max(idx, 0)];
  }

  private shouldFallback(config: NetConfig, now: number): boolean {
    if (this.routeBuildFailStreak >= 3) return true;
    if (this.relayPoolSize > 0 && this.relayPoolSize < config.selfOnionMinRelays) {
      return true;
    }
    if (this.sendHistory.length >= 20) {
      const failures = this.sendHistory.filter((event) => event === "send_fail").length;
      if (failures / this.sendHistory.length > 0.3) return true;
    }
    const p95 = this.getP95();
    if (p95 !== null && p95 > 10_000) {
      if (this.p95OverSince === null) {
        this.p95OverSince = now;
      } else if (now - this.p95OverSince >= 2 * 60 * 1000) {
        return true;
      }
    } else {
      this.p95OverSince = null;
    }
    return false;
  }
}

export const createRouteController = () => new RouteController();
