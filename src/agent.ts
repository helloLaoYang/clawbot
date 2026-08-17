import { ContextCompactionError, ContextEngine, ContextLimitError } from "./context.js";
import { KeyedSerialExecutor, Semaphore } from "./serial.js";
import { Store } from "./store.js";
import { WeixinApiClient } from "./weixin/api.js";
import { downloadImage } from "./weixin/media.js";
import type { WeixinMessage } from "./weixin/types.js";

const RESET_REPLY = "已清除你的全部会话历史和滚动摘要。";
const COMPACTION_FAILURE_REPLY = "上下文整理失败，请稍后重试。";
const CONTEXT_LIMIT_REPLY = "当前会话上下文仍然过长，请发送 /reset 后重试。";
const MODEL_FAILURE_REPLY = "AI 服务暂时不可用，请稍后重试。";
const UNSUPPORTED_REPLY = "暂不支持语音、文件或视频，请发送文本或图片。";

export class AgentService {
  private readonly concurrency: Semaphore;

  constructor(
    private readonly store: Store,
    private readonly context: ContextEngine,
    private readonly api: WeixinApiClient,
    maxConcurrentUsers: number,
    private readonly imageDownloader: typeof downloadImage = downloadImage,
    private readonly serial: KeyedSerialExecutor = new KeyedSerialExecutor(),
  ) { this.concurrency = new Semaphore(maxConcurrentUsers); }

  handle(accountId: string, message: WeixinMessage): Promise<void> {
    const peerId = message.from_user_id;
    if (!peerId) return Promise.resolve();
    return this.serial.run(`${accountId}\0${peerId}`, () => this.concurrency.run(() => this.process(accountId, message)));
  }

  private async process(accountId: string, message: WeixinMessage): Promise<void> {
    const rawSourceMessageId = message.message_id ?? message.client_id;
    const sourceMessageId = rawSourceMessageId === undefined ? undefined : String(rawSourceMessageId);
    if (!sourceMessageId || !message.from_user_id) return;
    if (message.message_type !== undefined && message.message_type !== 1) {
      if (!this.store.isProcessed(accountId, sourceMessageId)) this.store.markMessageProcessed(accountId, sourceMessageId);
      return;
    }
    if (this.store.isProcessed(accountId, sourceMessageId)) return;
    const credential = this.store.getCredential();
    if (!credential || credential.accountId !== accountId) throw new Error("Active Weixin account is missing");
    const contextToken = message.context_token ?? this.store.getPeerContext(accountId, message.from_user_id) ?? "";
    if (message.group_id) {
      this.store.markMessageProcessed(accountId, sourceMessageId, contextToken, message.from_user_id);
      return;
    }
    const items = message.item_list ?? [];
    const text = items.filter((item) => item.type === 1).map((item) => item.text_item?.text ?? "").filter(Boolean).join("\n");
    const imageItems = items.filter((item) => item.type === 2 && item.image_item).map((item) => item.image_item!);
    const unsupported = items.some((item) => item.type === 3 || item.type === 4 || item.type === 5);
    if (unsupported && !text && imageItems.length === 0) {
      await this.api.sendText(credential.baseUrl, credential.botToken, message.from_user_id, contextToken, UNSUPPORTED_REPLY);
      this.store.markMessageProcessed(accountId, sourceMessageId, contextToken, message.from_user_id);
      return;
    }
    if (text === "/reset" && imageItems.length === 0) {
      await this.api.sendText(credential.baseUrl, credential.botToken, message.from_user_id, contextToken, RESET_REPLY);
      this.store.reset(accountId, message.from_user_id, sourceMessageId, contextToken);
      return;
    }
    if (!text && imageItems.length === 0) {
      this.store.markMessageProcessed(accountId, sourceMessageId, contextToken, message.from_user_id);
      return;
    }
    if (imageItems.length > 4) {
      await this.api.sendText(credential.baseUrl, credential.botToken, message.from_user_id, contextToken, "一次最多发送 4 张图片。");
      this.store.markMessageProcessed(accountId, sourceMessageId, contextToken, message.from_user_id);
      return;
    }
    await this.api.setTyping(credential.baseUrl, credential.botToken, credential.ilinkUserId, contextToken, true);
    try {
      let images;
      try {
        images = await Promise.all(imageItems.map(this.imageDownloader));
        if (images.reduce((sum, image) => sum + image.bytes, 0) > 20 * 1024 * 1024) throw new Error("Images exceed 20 MiB total");
      } catch {
        await this.api.sendText(credential.baseUrl, credential.botToken, message.from_user_id, contextToken, "图片读取失败，请重新发送尺寸不超过 10 MiB 的 JPEG、PNG、GIF 或 WebP 图片。");
        this.store.markMessageProcessed(accountId, sourceMessageId, contextToken, message.from_user_id);
        return;
      }
      let result;
      try {
        result = await this.context.respond(accountId, message.from_user_id, { text, images: images.map(({ dataUrl }) => ({ dataUrl })) });
      } catch (error) {
        const reply = error instanceof ContextCompactionError ? COMPACTION_FAILURE_REPLY
          : error instanceof ContextLimitError ? CONTEXT_LIMIT_REPLY : MODEL_FAILURE_REPLY;
        await this.api.sendText(credential.baseUrl, credential.botToken, message.from_user_id, contextToken, reply);
        this.store.markMessageProcessed(accountId, sourceMessageId, contextToken, message.from_user_id);
        return;
      }
      await this.api.sendText(credential.baseUrl, credential.botToken, message.from_user_id, contextToken, result.text);
      const placeholder = imageItems.length ? `[用户发送了${imageItems.length}张图片]` : "";
      const persistedUserText = [text, placeholder].filter(Boolean).join("\n");
      this.store.saveTurn({
        accountId, peerId: message.from_user_id, sourceMessageId,
        userText: persistedUserText, userType: imageItems.length ? "image" : "text",
        assistantText: result.text, inputTokens: result.inputTokens, contextToken,
      });
    } finally {
      await this.api.setTyping(credential.baseUrl, credential.botToken, credential.ilinkUserId, contextToken, false);
    }
  }
}
