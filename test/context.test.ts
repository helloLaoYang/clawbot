import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { ContextCompactionError, ContextEngine } from "../src/context.js";
import { makeStore, StubModel, contextConfig, key } from "./helpers.js";
import { SecretBox } from "../src/crypto.js";
import { Store } from "../src/store.js";

function turn(store: Store, peerId: string, index: number, text = `message-${index}`) {
  store.saveTurn({ accountId: "account-1", peerId, sourceMessageId: `${peerId}-${index}`, userText: text, userType: "text", assistantText: `answer-${index}`, inputTokens: 10, contextToken: `ctx-${peerId}` });
}

describe("ContextEngine", () => {
  it("isolates histories by user", async () => {
    const store = makeStore(); const model = new StubModel();
    turn(store, "alice", 1, "alice-only"); turn(store, "bob", 1, "bob-only");
    await new ContextEngine(store, model, contextConfig).respond("account-1", "alice", { text: "next", images: [] });
    expect(model.generateRequests[0]?.history.map((item) => item.text)).toContain("alice-only");
    expect(model.generateRequests[0]?.history.map((item) => item.text)).not.toContain("bob-only");
    store.close();
  });

  it("loads persistent global persona and personalization for every response", async () => {
    const store = makeStore(); const model = new StubModel();
    store.updateGlobalSettings({ persona: "你叫小爪", personalization: "默认简体中文并先给结论" });
    await new ContextEngine(store, model, contextConfig).respond("account-1", "alice", { text: "hello", images: [] });
    expect(model.generateRequests[0]?.settings).toEqual({
      persona: "你叫小爪",
      personalization: "默认简体中文并先给结论",
      updatedAt: expect.any(String),
    });
    store.close();
  });

  it("compacts old messages, advances the boundary, and retains raw history", async () => {
    const store = makeStore(); const model = new StubModel();
    for (let index = 0; index < 4; index++) turn(store, "alice", index, "x".repeat(90));
    const config = { ...contextConfig, windowTokens: 500, compactRatio: 0.5, keepMessages: 2 };
    await new ContextEngine(store, model, config).respond("account-1", "alice", { text: "next", images: [] });
    const conversation = store.getConversation("account-1", "alice");
    expect(model.summarizeRequests).toHaveLength(1);
    expect(model.summarizeRequests[0]?.count).toBe(6);
    expect(conversation.summaryThroughMessageId).not.toBeNull();
    expect(store.listMessagesAfter("account-1", "alice", null)).toHaveLength(8);
    expect(model.generateRequests[0]?.history).toHaveLength(2);
    store.close();
  });

  it("does not advance the boundary when summary generation fails", async () => {
    const store = makeStore(); const model = new StubModel();
    for (let index = 0; index < 3; index++) turn(store, "alice", index, "x".repeat(100));
    model.summarizeImpl = async () => { throw new Error("stub failure"); };
    const engine = new ContextEngine(store, model, { ...contextConfig, windowTokens: 400, compactRatio: 0.5, keepMessages: 2 });
    await expect(engine.respond("account-1", "alice", { text: "next", images: [] })).rejects.toBeInstanceOf(ContextCompactionError);
    expect(store.getConversation("account-1", "alice").summaryThroughMessageId).toBeNull();
    expect(store.listMessagesAfter("account-1", "alice", null)).toHaveLength(6);
    store.close();
  });

  it("restores summary and recent messages after restart", () => {
    const path = join(mkdtempSync(join(tmpdir(), "clawbot-")), "test.sqlite");
    const first = new Store(path, new SecretBox(key));
    turn(first, "alice", 1); turn(first, "alice", 2);
    first.updateSummary("account-1", "alice", "durable summary", 2);
    first.updateGlobalSettings({ persona: "durable persona", personalization: "durable preference" });
    first.close();
    const second = new Store(path, new SecretBox(key));
    expect(second.getConversation("account-1", "alice").summary).toBe("durable summary");
    expect(second.listMessagesAfter("account-1", "alice", 2)).toHaveLength(2);
    expect(second.getGlobalSettings()).toMatchObject({ persona: "durable persona", personalization: "durable preference" });
    second.close();
  });

  it("performs only one emergency compaction retry", async () => {
    const store = makeStore(); const model = new StubModel();
    for (let index = 0; index < 4; index++) turn(store, "alice", index);
    model.generateImpl = async () => { throw new Error("CONTEXT_LIMIT"); };
    const engine = new ContextEngine(store, model, { ...contextConfig, windowTokens: 100_000, keepMessages: 4 });
    await expect(engine.respond("account-1", "alice", { text: "next", images: [] })).rejects.toThrow("context remains too large");
    expect(model.generateRequests).toHaveLength(2);
    expect(model.summarizeRequests).toHaveLength(1);
    store.close();
  });
});
