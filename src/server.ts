import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { adminPage } from "./admin-page.js";
import type { AppConfig } from "./config.js";
import { safeTokenEqual } from "./crypto.js";
import type { Store } from "./store.js";
import type { LoginManager } from "./weixin/login.js";
import type { WeixinMonitor } from "./weixin/monitor.js";
import { WebhookPeerUnknownError, type WebhookService, WebhookUnavailableError } from "./webhook.js";

export type ServerDependencies = { config: AppConfig; store: Store; login: LoginManager; monitor: WeixinMonitor; webhook: WebhookService };

export function buildServer(deps: ServerDependencies): FastifyInstance {
  const app = Fastify({ logger: true, bodyLimit: 32 * 1024 });
  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async (_request, reply) => {
    const credential = deps.store.getCredential();
    const monitor = deps.monitor.getStatus();
    const ready = deps.store.ping() && credential?.status === "active" && monitor.running && monitor.healthy;
    return reply.code(ready ? 200 : 503).send({ status: ready ? "ready" : "not_ready" });
  });
  app.get("/admin", async (_request, reply) => reply.type("text/html; charset=utf-8").send(adminPage));

  app.addHook("preHandler", async (request, reply) => {
    const isAdmin = request.url.startsWith("/api/admin/");
    const isWebhook = request.url.startsWith("/api/webhooks/");
    if (!isAdmin && !isWebhook) return;
    const authorization = request.headers.authorization;
    const actual = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
    const expected = isWebhook ? deps.config.webhookToken : deps.config.adminToken;
    if (!safeTokenEqual(actual, expected)) return reply.code(401).send({ error: "unauthorized" });
  });

  app.get("/api/admin/status", async () => {
    const credential = deps.store.getCredential();
    return {
      database: deps.store.ping() ? "ok" : "error",
      model: { configured: true, baseUrl: new URL(deps.config.openai.baseURL).origin, model: deps.config.openai.model },
      weixin: {
        configured: Boolean(credential), credentialStatus: credential?.status ?? "missing",
        accountId: credential ? mask(credential.accountId) : null,
        polling: deps.monitor.getStatus(),
      },
    };
  });
  app.post("/api/admin/weixin/login-sessions", async (_request, reply) => reply.code(201).send(await deps.login.create()));
  app.get<{ Params: { id: string } }>("/api/admin/weixin/login-sessions/:id", async (request, reply) => {
    const session = deps.login.get(request.params.id);
    return session ? session : reply.code(404).send({ error: "login session not found" });
  });
  app.post<{ Params: { id: string }; Body: unknown }>("/api/admin/weixin/login-sessions/:id/verify-code", async (request, reply) => {
    const parsed = z.object({ code: z.string().regex(/^\d{4,8}$/) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "code must contain 4-8 digits" });
    const session = deps.login.verify(request.params.id, parsed.data.code);
    return session ? session : reply.code(404).send({ error: "login session not found" });
  });
  app.post<{ Body: unknown }>("/api/webhooks/messages", async (request, reply) => {
    const parsed = z.object({
      peer_id: z.string().min(1).max(256),
      text: z.string().min(1).max(20_000),
      idempotency_key: z.string().min(1).max(128).optional(),
    }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "body must contain peer_id and text" });
    const headerKey = request.headers["idempotency-key"];
    const idempotencyKey = typeof headerKey === "string" ? headerKey : parsed.data.idempotency_key;
    try {
      return await deps.webhook.send(parsed.data.peer_id, parsed.data.text, idempotencyKey);
    } catch (error) {
      if (error instanceof WebhookPeerUnknownError) return reply.code(409).send({ error: error.message });
      if (error instanceof WebhookUnavailableError) return reply.code(503).send({ error: error.message });
      request.log.error({ err: error }, "webhook delivery failed");
      return reply.code(502).send({ error: "微信消息发送失败" });
    }
  });
  app.get("/api/webhooks/peers", async (_request, reply) => {
    try {
      return { peers: deps.webhook.listPeers() };
    } catch (error) {
      if (error instanceof WebhookUnavailableError) return reply.code(503).send({ error: error.message });
      return reply.code(500).send({ error: "用户列表读取失败" });
    }
  });
  return app;
}

function mask(value: string): string {
  return value.length <= 8 ? "****" : `${value.slice(0, 4)}…${value.slice(-4)}`;
}
