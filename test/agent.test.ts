import { describe, expect, it } from "vitest";
import { AgentService } from "../src/agent.js";
import { ContextEngine } from "../src/context.js";
import { contextConfig, makeStore, seedCredential, StubModel, StubWeixinApi } from "./helpers.js";

const message = (peer: string, id: string, text: string) => ({
  message_id: id, from_user_id: peer, context_token: `ctx-${peer}`,
  item_list: [{ type: 1, text_item: { text } }],
});

describe("AgentService", () => {
  it("serializes the same user while allowing independent per-user context", async () => {
    const store = makeStore(); seedCredential(store);
    const model = new StubModel(); const api = new StubWeixinApi();
    model.generateImpl = async (request) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { text: `history:${request.history.length}`, inputTokens: 5 };
    };
    const agent = new AgentService(store, new ContextEngine(store, model, contextConfig), api, 4);
    await Promise.all([agent.handle("account-1", message("alice", "m1", "one")), agent.handle("account-1", message("alice", "m2", "two"))]);
    expect(model.generateRequests.map((request) => request.history.length)).toEqual([0, 2]);
    expect(store.listMessagesAfter("account-1", "alice", null)).toHaveLength(4);
    store.close();
  });

  it("clears only the requesting user's memory after a second confirmation", async () => {
    const store = makeStore(); seedCredential(store); const model = new StubModel(); const api = new StubWeixinApi();
    const agent = new AgentService(store, new ContextEngine(store, model, contextConfig), api, 4);
    await agent.handle("account-1", message("alice", "a1", "hello"));
    await agent.handle("account-1", message("bob", "b1", "hello"));
    await agent.handle("account-1", message("alice", "a2", "/clear"));
    expect(store.listMessagesAfter("account-1", "alice", null)).toHaveLength(2);
    expect(api.sent.at(-1)?.text).toContain("再次发送 /clear");
    await agent.handle("account-1", message("alice", "a3", "/clear"));
    expect(store.listMessagesAfter("account-1", "alice", null)).toHaveLength(0);
    expect(store.listMessagesAfter("account-1", "bob", null)).toHaveLength(2);
    expect(model.generateRequests).toHaveLength(2);
    expect(api.sent.at(-1)?.text).toContain("已清除");
    store.close();
  });

  it("handles help without calling the model and disables the old reset bypass", async () => {
    const store = makeStore(); seedCredential(store); const model = new StubModel(); const api = new StubWeixinApi();
    const agent = new AgentService(store, new ContextEngine(store, model, contextConfig), api, 4);
    await agent.handle("account-1", message("alice", "h1", "/help"));
    await agent.handle("account-1", message("alice", "h2", "/reset"));
    expect(model.generateRequests).toHaveLength(0);
    expect(api.sent[0]?.text).toContain("/compact");
    expect(api.sent[1]?.text).toContain("/reset 已停用");
    store.close();
  });

  it("manually compacts all uncompressed messages while retaining raw history", async () => {
    const store = makeStore(); seedCredential(store); const model = new StubModel(); const api = new StubWeixinApi();
    const agent = new AgentService(store, new ContextEngine(store, model, contextConfig), api, 4);
    await agent.handle("account-1", message("alice", "m1", "hello"));
    await agent.handle("account-1", message("alice", "m2", "world"));
    await agent.handle("account-1", message("alice", "m3", "/compact"));
    expect(model.summarizeRequests).toEqual([{ summary: "", count: 4 }]);
    expect(store.getConversation("account-1", "alice").summaryThroughMessageId).not.toBeNull();
    expect(store.listMessagesAfter("account-1", "alice", null)).toHaveLength(4);
    expect(store.listMessagesAfter("account-1", "alice", store.getConversation("account-1", "alice").summaryThroughMessageId)).toHaveLength(0);
    expect(api.sent.at(-1)?.text).toContain("4 条消息");
    store.close();
  });

  it("deduplicates persisted Weixin message ids", async () => {
    const store = makeStore(); seedCredential(store); const model = new StubModel(); const api = new StubWeixinApi();
    const agent = new AgentService(store, new ContextEngine(store, model, contextConfig), api, 4);
    await agent.handle("account-1", message("alice", "same", "hello"));
    await agent.handle("account-1", message("alice", "same", "hello"));
    expect(model.generateRequests).toHaveLength(1);
    expect(api.sent).toHaveLength(1);
    store.close();
  });

  it("sends image bytes only in the current request and stores a placeholder", async () => {
    const store = makeStore(); seedCredential(store); const model = new StubModel(); const api = new StubWeixinApi();
    const agent = new AgentService(
      store, new ContextEngine(store, model, contextConfig), api, 4,
      async () => ({ dataUrl: "data:image/png;base64,SECRET_IMAGE_BYTES", bytes: 16 }),
    );
    await agent.handle("account-1", {
      message_id: "image-1", from_user_id: "alice", context_token: "ctx-alice",
      item_list: [{ type: 2, image_item: { aeskey: "00112233445566778899aabbccddeeff", media: { full_url: "https://novac2c.cdn.weixin.qq.com/c2c/example" } } }],
    });
    await agent.handle("account-1", message("alice", "after-image", "what next"));
    expect(model.generateRequests[0]?.current.images[0]?.dataUrl).toContain("SECRET_IMAGE_BYTES");
    expect(model.generateRequests[1]?.current.images).toHaveLength(0);
    expect(model.generateRequests[1]?.history[0]?.text).toBe("[用户发送了1张图片]");
    expect(JSON.stringify(store.listMessagesAfter("account-1", "alice", null))).not.toContain("SECRET_IMAGE_BYTES");
    store.close();
  });
});
