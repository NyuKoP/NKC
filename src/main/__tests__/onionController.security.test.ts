import { afterEach, describe, expect, it } from "vitest";
import { startOnionController, type OnionControllerHandle } from "../onionController";

let controller: OnionControllerHandle | null = null;

afterEach(async () => {
  await controller?.close();
  controller = null;
});

const request = (path: string, init?: RequestInit) =>
  fetch(`${controller?.baseUrl}${path}`, init);

const authorizedHeaders = () => ({
  "Content-Type": "application/json",
  "X-NKC-Controller-Token": controller?.authToken ?? "",
});

describe("onion controller security boundary", () => {
  it("blocks browser-origin requests and unauthenticated local routes", async () => {
    controller = await startOnionController({ port: 0 });

    const browserResponse = await request("/onion/health", {
      headers: { Origin: "https://attacker.example" },
    });
    expect(browserResponse.status).toBe(403);
    expect(browserResponse.headers.get("access-control-allow-origin")).toBeNull();

    const unauthenticatedResponse = await request("/onion/address");
    expect(unauthenticatedResponse.status).toBe(401);

    const authenticatedResponse = await request("/onion/address", {
      headers: authorizedHeaders(),
    });
    expect(authenticatedResponse.status).toBe(200);
  });

  it("keeps ingress public while draining acknowledged inbox entries", async () => {
    controller = await startOnionController({ port: 0 });

    const ingestResponse = await request("/onion/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toDeviceId: "device-a", from: "peer-a", envelope: "ciphertext" }),
    });
    expect(ingestResponse.status).toBe(200);

    const firstPoll = await request("/onion/inbox?deviceId=device-a", {
      headers: authorizedHeaders(),
    });
    const firstPayload = (await firstPoll.json()) as {
      items: Array<{ envelope: string }>;
      nextAfter: string | null;
    };
    expect(firstPayload.items).toHaveLength(1);
    expect(firstPayload.items[0]?.envelope).toBe("ciphertext");
    expect(firstPayload.nextAfter).toBe("0");

    const acknowledgedPoll = await request("/onion/inbox?deviceId=device-a&after=0", {
      headers: authorizedHeaders(),
    });
    const acknowledgedPayload = (await acknowledgedPoll.json()) as { items: unknown[] };
    expect(acknowledgedPayload.items).toEqual([]);
  });

  it("rejects malformed ingress identifiers without destabilizing the controller", async () => {
    controller = await startOnionController({ port: 0 });

    const malformedResponse = await request("/onion/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toDeviceId: { nested: true }, envelope: "ciphertext" }),
    });
    expect(malformedResponse.status).toBe(400);

    const healthResponse = await request("/onion/health");
    expect(healthResponse.status).toBe(200);
  });
});
