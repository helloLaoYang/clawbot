import { ContextCompactionError, ContextEngine, ContextLimitError } from "./context.js";
import { KeyedSerialExecutor, Semaphore } from "./serial.js";
import { Store } from "./store.js";
import { WeixinApiClient } from "./weixin/api.js";
import { downloadImage } from "./weixin/media.js";
import type { WeixinMessage } from "./weixin/types.js";

const HELP_REPLY = `可用命令：
/help - 查看帮助
/clear - 清理你的全部聊天记录和滚动摘要（需要在 5 分钟内再次发送确认）
/compact - 将你的全部未压缩会话内容合入滚动摘要，原始记录仍会保留`;
const CLEAR_CONFIRM_REPLY = "此操作将清理你的全部聊天记录和滚动摘要，且无法恢复。请在 5 分钟内再次发送 /clear 确认。";
const CLEAR_DONE_REPLY = "已清除你的全部聊天记录和滚动摘要。";
const RESET_DEPRECATED_REPLY = "为避免误操作，/reset 已停用。请发送 /clear，并按提示再次确认。";
const COMPACTION_FAILURE_REPLY = "上下文整理失败，请稍后重试。";
const CONTEXT_LIMIT_REPLY = "当前会话上下文仍然过长，请先发送 /compact；如仍失败，可使用 /clear 二次确认清理后重试。";
const MODEL_FAILURE_REPLY = "AI 服务暂时不可用，请稍后重试。";
const UNSUPPORTED_REPLY = "暂不支持语音、文件或视频，请发送文本或图片。";
const CLEAR_CONFIRMATION_TTL_MS = 5 * 60 * 1000;

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
    if (text === "/help" && imageItems.length === 0) {
      await this.api.sendText(credential.baseUrl, credential.botToken, message.from_user_id, contextToken, HELP_REPLY);
      this.store.markMessageProcessed(accountId, sourceMessageId, contextToken, message.from_user_id);
      return;
    }
    if (text === "/reset" && imageItems.length === 0) {
      await this.api.sendText(credential.baseUrl, credential.botToken, message.from_user_id, contextToken, RESET_DEPRECATED_REPLY);
      this.store.markMessageProcessed(accountId, sourceMessageId, contextToken, message.from_user_id);
      return;
    }
    if (text === "/clear" && imageItems.length === 0) {
      const confirmed = this.store.hasCommandConfirmation(accountId, message.from_user_id, "clear");
      await this.api.sendText(
        credential.baseUrl, credential.botToken, message.from_user_id, contextToken,
        confirmed ? CLEAR_DONE_REPLY : CLEAR_CONFIRM_REPLY,
      );
      if (confirmed) {
        this.store.reset(accountId, message.from_user_id, sourceMessageId, contextToken);
      } else {
        this.store.setCommandConfirmation({
          accountId, peerId: message.from_user_id, command: "clear", sourceMessageId, contextToken,
          ttlMs: CLEAR_CONFIRMATION_TTL_MS,
        });
      }
      return;
    }
    if (text === "/compact" && imageItems.length === 0) {
      await this.api.setTyping(credential.baseUrl, credential.botToken, credential.ilinkUserId, contextToken, true);
      try {
        let reply: string;
        try {
          const compactedMessages = await this.context.compactAll(accountId, message.from_user_id);
          reply = compactedMessages > 0
            ? `已将你的全部未压缩会话内容（${compactedMessages} 条消息）合入滚动摘要，原始记录仍然保留。`
            : "当前没有需要压缩的新会话内容。";
        } catch {
          reply = COMPACTION_FAILURE_REPLY;
        }
        await this.api.sendText(credential.baseUrl, credential.botToken, message.from_user_id, contextToken, reply);
        this.store.markMessageProcessed(accountId, sourceMessageId, contextToken, message.from_user_id);
      } finally {
        await this.api.setTyping(credential.baseUrl, credential.botToken, credential.ilinkUserId, contextToken, false);
      }
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
