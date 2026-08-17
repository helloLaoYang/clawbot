import { describe, expect, it } from "vitest";
import { loadLocalEnvironment, runCli } from "../src/cli.js";
import { KeyedSerialExecutor } from "../src/serial.js";
import { WebhookPeerUnknownError, WebhookService } from "../src/webhook.js";
import { makeStore, seedCredential, StubWeixinApi } from "./helpers.js";

describe("WebhookService", () => {
  it("sends with the latest peer context and persists assistant history", async () => {
    const store = makeStore(); seedCredential(store);
    store.markMessageProcessed("account-1", "seed", "ctx-alice", "alice");
    const api = new StubWeixinApi();
    const webhook = new WebhookService(store, api, new KeyedSerialExecutor());
    const result = await webhook.send("alice", "scheduled hello", "job-1");
    expect(result).toEqual({ status: "sent", peerId: "alice" });
    expect(api.sent).toEqual([{ peer: "alice", text: "scheduled hello" }]);
    expect(store.listMessagesAfter("account-1", "alice", null)).toMatchObject([{ role: "assistant", text: "scheduled hello" }]);
    expect(webhook.listPeers()).toMatchObject([{ peerId: "alice" }]);
    store.close();
  });

  it("deduplicates concurrent webhook retries by idempotency key", async () => {
    const store = makeStore(); seedCredential(store);
    store.markMessageProcessed("account-1", "seed", "ctx-alice", "alice");
    const api = new StubWeixinApi();
    const webhook = new WebhookService(store, api, new KeyedSerialExecutor());
    const results = await Promise.all([
      webhook.send("alice", "once", "same-key"),
      webhook.send("alice", "once", "same-key"),
    ]);
    expect(results.map((item) => item.status).sort()).toEqual(["duplicate", "sent"]);
    expect(api.sent).toHaveLength(1);
    store.close();
  });

  it("rejects peers without a prior inbound context token", async () => {
    const store = makeStore(); seedCredential(store);
    const webhook = new WebhookService(store, new StubWeixinApi(), new KeyedSerialExecutor());
    await expect(webhook.send("unknown", "hello")).rejects.toBeInstanceOf(WebhookPeerUnknownError);
    store.close();
  });
});

describe("Clawbot CLI", () => {
  it("loads the project .env for direct local CLI usage", () => {
    const loaded: string[] = [];
    loadLocalEnvironment((path) => loaded.push(path ?? ""));
    expect(loaded).toEqual([".env"]);
  });

  it("sends through the webhook endpoint", async () => {
    let request: Request | undefined;
    const fetchStub: typeof fetch = async (input, init) => {
      request = new Request(input, init);
      return new Response(JSON.stringify({ status: "sent", peerId: "alice" }), { status: 200 });
    };
    const logs: string[] = []; const errors: string[] = [];
    const code = await runCli(
      ["send", "--peer", "alice", "--text", "hello", "--idempotency-key", "job-42"],
      { WEBHOOK_TOKEN: "0123456789abcdef", CLAWBOT_URL: "http://clawbot.test/" }, fetchStub,
      { log: (value) => logs.push(value), error: (value) => errors.push(value) },
    );
    expect(code).toBe(0);
    expect(request?.url).toBe("http://clawbot.test/api/webhooks/messages");
    expect(request?.headers.get("authorization")).toBe("Bearer 0123456789abcdef");
    expect(request?.headers.get("idempotency-key")).toBe("job-42");
    expect(await request?.clone().json()).toEqual({ peer_id: "alice", text: "hello" });
    expect(errors).toHaveLength(0);
    expect(logs[0]).toContain("sent");
  });

  it("returns usage errors without making a request", async () => {
    const errors: string[] = [];
    const code = await runCli(["send", "--peer", "alice"], {}, async () => { throw new Error("must not fetch"); }, {
      log: () => undefined, error: (value) => errors.push(value),
    });
    expect(code).toBe(2);
    expect(errors[0]).toContain("requires");
  });
});
