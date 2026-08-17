import type { AppConfig } from "./config.js";
import { ContextEngine } from "./context.js";
import { SecretBox } from "./crypto.js";
import { ResponsesModelClient, type ModelClient } from "./model.js";
import { AgentService } from "./agent.js";
import { buildServer } from "./server.js";
import { Store } from "./store.js";
import { WeixinApiClient } from "./weixin/api.js";
import { LoginManager } from "./weixin/login.js";
import { WeixinMonitor } from "./weixin/monitor.js";
import { KeyedSerialExecutor } from "./serial.js";
import { downloadImage } from "./weixin/media.js";
import { WebhookService } from "./webhook.js";

export function createRuntime(config: AppConfig, overrides: { model?: ModelClient; api?: WeixinApiClient } = {}) {
  const store = new Store(config.databasePath, new SecretBox(config.encryptionKey));
  const model = overrides.model ?? new ResponsesModelClient(config.openai.baseURL, config.openai.apiKey, config.openai.model);
  const api = overrides.api ?? new WeixinApiClient();
  const context = new ContextEngine(store, model, config.context);
  const serial = new KeyedSerialExecutor();
  const agent = new AgentService(store, context, api, config.maxConcurrentUsers, downloadImage, serial);
  const webhook = new WebhookService(store, api, serial);
  const monitor = new WeixinMonitor(store, api, agent);
  const login = new LoginManager(api, store, () => { monitor.stop(); monitor.start(); });
  const server = buildServer({ config, store, login, monitor, webhook });
  return { server, store, monitor, login, agent, context, webhook };
}
