import { createCipheriv } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResponsesModelClient } from "../src/model.js";
import { buildServer } from "../src/server.js";
import type { AppConfig } from "../src/config.js";
import { makeStore, seedCredential } from "./helpers.js";
import { WeixinApiClient, WeixinAuthInvalidError } from "../src/weixin/api.js";
import { downloadImage } from "../src/weixin/media.js";

describe("HTTP adapters", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { vi.unstubAllGlobals(); while (closers.length) await closers.pop()?.(); });

  it("uses non-streaming Responses with manual history and store=false", async () => {
    let received: Record<string, unknown> = {};
    const httpStub: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      received = await request.clone().json() as Record<string, unknown>;
      return new Response(JSON.stringify({
          id: "resp_stub", object: "response", created_at: 1, status: "completed", model: "stub-model",
          output: [{ id: "msg_stub", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: "stub reply", annotations: [] }] }],
          usage: { input_tokens: 42, input_tokens_details: { cached_tokens: 0 }, output_tokens: 2, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 44 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const client = new ResponsesModelClient("http://responses.stub/v1", "stub-key", "stub-model", httpStub);
    const result = await client.generate({
      summary: "old facts", history: [{ id: 1, role: "assistant", text: "prior", messageType: "text", sourceMessageId: null, createdAt: "now" }],
      current: { text: "hello", images: [{ dataUrl: "data:image/png;base64,AA==" }] },
      settings: { persona: "你叫小爪", personalization: "回答简洁" },
    });
    expect(result).toEqual({ text: "stub reply", inputTokens: 42 });
    expect(received.store).toBe(false);
    expect(received).not.toHaveProperty("previous_response_id");
    expect(JSON.stringify(received.input)).toContain("input_image");
    expect(received.instructions).toContain("你叫小爪");
    expect(received.instructions).toContain("回答简洁");
    expect(received.instructions).toContain("不可信的历史数据");
  });

  it("protects admin APIs and reports readiness independently from liveness", async () => {
    const store = makeStore(); seedCredential(store);
    const config = {
      host: "127.0.0.1", port: 3000, databasePath: ":memory:",
      openai: { baseURL: "https://api.openai.com/v1", apiKey: "secret", model: "stub" },
      adminToken: "0123456789abcdef", encryptionKey: Buffer.alloc(32),
      webhookToken: "fedcba9876543210",
      context: { windowTokens: 32000, compactRatio: 0.7, keepMessages: 20, summaryMaxTokens: 1500, imageTokens: 2000 },
      maxConcurrentUsers: 4,
    } satisfies AppConfig;
    const login = { create: async () => ({ id: "x" }), get: () => null, verify: () => null };
    const monitor = { getStatus: () => ({ running: true, healthy: true, lastSuccessAt: "now", lastError: null }) };
    const webhook = { send: async (peerId: string) => ({ status: "sent" as const, peerId }) };
    const app = buildServer({ config, store, login: login as never, monitor: monitor as never, webhook: webhook as never });
    closers.push(async () => { await app.close(); store.close(); });
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/admin" })).body).toContain("全局 AI 设置");
    expect((await app.inject({ method: "GET", url: "/api/admin/status" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/admin/settings" })).statusCode).toBe(401);
    const authorized = await app.inject({ method: "GET", url: "/api/admin/status", headers: { authorization: "Bearer 0123456789abcdef" } });
    expect(authorized.statusCode).toBe(200);
    expect(authorized.body).not.toContain("secret");
    const settingsResponse = await app.inject({
      method: "PUT", url: "/api/admin/settings",
      headers: { authorization: "Bearer 0123456789abcdef" },
      payload: { persona: " 小爪 ", personalization: " 简洁回答 " },
    });
    expect(settingsResponse.statusCode).toBe(200);
    expect(settingsResponse.json()).toMatchObject({ persona: "小爪", personalization: "简洁回答" });
    const savedSettings = await app.inject({
      method: "GET", url: "/api/admin/settings", headers: { authorization: "Bearer 0123456789abcdef" },
    });
    expect(savedSettings.json()).toMatchObject({ persona: "小爪", personalization: "简洁回答" });
    const loginResponse = await app.inject({
      method: "POST", url: "/api/admin/weixin/login-sessions",
      headers: { authorization: "Bearer 0123456789abcdef" },
      payload: {},
    });
    expect(loginResponse.statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: "/api/webhooks/messages", payload: { peer_id: "alice", text: "hello" } })).statusCode).toBe(401);
    const webhookResponse = await app.inject({
      method: "POST", url: "/api/webhooks/messages",
      headers: { authorization: "Bearer fedcba9876543210" }, payload: { peer_id: "alice", text: "hello" },
    });
    expect(webhookResponse.json()).toEqual({ status: "sent", peerId: "alice" });
  });

  it("matches the Weixin 2.4.6 QR, update and send request shapes", async () => {
    const calls: Request[] = [];
    const payloads = [
      { ret: 0, qrcode: "qr-id", qrcode_img_content: "https://liteapp.weixin.qq.com/q/demo" },
      { ret: 0, msgs: [], get_updates_buf: "cursor-2" },
      { ret: 0 },
    ];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new Request(input, init));
      return new Response(JSON.stringify(payloads.shift()), { status: 200, headers: { "content-type": "application/json" } });
    });
    const api = new WeixinApiClient();
    await api.createQrCode(undefined, ["old-token"]);
    await api.getUpdates("https://ilinkai.weixin.qq.com", "bot-token", "cursor-1");
    await api.sendText("https://ilinkai.weixin.qq.com", "bot-token", "peer", "context", "reply");
    expect(calls[0]?.method).toBe("POST");
    expect(await calls[0]?.clone().json()).toEqual({ local_token_list: ["old-token"] });
    const updateBody = await calls[1]?.clone().json() as Record<string, unknown>;
    expect(updateBody.get_updates_buf).toBe("cursor-1");
    expect(JSON.stringify(updateBody)).toContain("2.4.6");
    expect(JSON.stringify(updateBody)).toContain("Clawbot/0.1.0");
    const sendBody = await calls[2]?.clone().json() as { msg: { context_token: string; to_user_id: string } };
    expect(sendBody.msg).toMatchObject({ context_token: "context", to_user_id: "peer" });
    expect(calls[2]?.headers.get("authorization")).toBe("Bearer bot-token");
  });

  it("recognizes stale Weixin credentials and decrypts CDN images in memory", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ ret: 0, errcode: -14 }), { status: 200, headers: { "content-type": "application/json" } }));
    await expect(new WeixinApiClient().getUpdates("https://ilinkai.weixin.qq.com", "bad", "")).rejects.toBeInstanceOf(WeixinAuthInvalidError);

    const key = Buffer.from("00112233445566778899aabbccddeeff", "hex");
    const png = Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), Buffer.from("stub-pixels")]);
    const cipher = createCipheriv("aes-128-ecb", key, null);
    const encrypted = Buffer.concat([cipher.update(png), cipher.final()]);
    vi.stubGlobal("fetch", async () => new Response(encrypted, { status: 200 }));
    const image = await downloadImage({ aeskey: key.toString("hex"), media: { full_url: "https://novac2c.cdn.weixin.qq.com/c2c/test" } });
    expect(image.dataUrl).toBe(`data:image/png;base64,${png.toString("base64")}`);
  });
});
