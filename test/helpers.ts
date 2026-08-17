import { SecretBox } from "../src/crypto.js";
import type { GenerateRequest, GenerateResult, ModelClient } from "../src/model.js";
import { Store } from "../src/store.js";
import { WeixinApiClient } from "../src/weixin/api.js";

export const key = Buffer.alloc(32, 7);
export const makeStore = (path = ":memory:") => new Store(path, new SecretBox(key));

export class StubModel implements ModelClient {
  readonly generateRequests: GenerateRequest[] = [];
  readonly summarizeRequests: Array<{ summary: string; count: number }> = [];
  generateImpl: (request: GenerateRequest) => Promise<GenerateResult> = async () => ({ text: "ok", inputTokens: 10 });
  summarizeImpl: (summary: string) => Promise<string> = async (summary) => `${summary} compacted`.trim();
  async generate(request: GenerateRequest) { this.generateRequests.push(request); return this.generateImpl(request); }
  async summarize(summary: string, messages: unknown[]) { this.summarizeRequests.push({ summary, count: messages.length }); return this.summarizeImpl(summary); }
  isContextLengthError(error: unknown) { return error instanceof Error && error.message === "CONTEXT_LIMIT"; }
}

export class StubWeixinApi extends WeixinApiClient {
  readonly sent: Array<{ peer: string; text: string }> = [];
  override async sendText(_base: string, _token: string, peer: string, _context: string, text: string) { this.sent.push({ peer, text }); }
  override async setTyping() {}
}

export function seedCredential(store: Store) {
  store.saveCredential({ accountId: "account-1", botToken: "secret", baseUrl: "https://ilinkai.weixin.qq.com", ilinkUserId: "bot-user", cursor: "" });
}

export const contextConfig = { windowTokens: 32_000, compactRatio: 0.7, keepMessages: 20, summaryMaxTokens: 1_500, imageTokens: 2_000 };
