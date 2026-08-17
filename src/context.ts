import type { AppConfig } from "./config.js";
import type { CurrentInput, GenerateResult, ModelClient } from "./model.js";
import { Store, type Conversation, type StoredMessage } from "./store.js";

export class ContextCompactionError extends Error {
  constructor(message = "context compaction failed", options?: ErrorOptions) { super(message, options); }
}
export class ContextLimitError extends Error {}

type ContextConfig = AppConfig["context"];

export class ContextEngine {
  constructor(private readonly store: Store, private readonly model: ModelClient, private readonly config: ContextConfig) {}

  async respond(accountId: string, peerId: string, current: CurrentInput): Promise<GenerateResult> {
    let context = this.load(accountId, peerId);
    const estimate = estimateInputTokens(context.conversation.summary, context.messages, current, this.config.imageTokens);
    if (estimate >= this.config.windowTokens * this.config.compactRatio) {
      context = await this.compact(accountId, peerId, context, this.config.keepMessages);
    }
    try {
      const result = await this.model.generate({
        summary: context.conversation.summary,
        history: context.messages,
        current,
      });
      return { ...result, inputTokens: result.inputTokens || estimateInputTokens(context.conversation.summary, context.messages, current, this.config.imageTokens) };
    } catch (error) {
      if (!this.model.isContextLengthError(error)) throw error;
      const emergencyKeep = Math.max(2, Math.floor(this.config.keepMessages / 2));
      const emergency = await this.compact(accountId, peerId, context, emergencyKeep, true);
      try {
        const result = await this.model.generate({ summary: emergency.conversation.summary, history: emergency.messages, current });
        return { ...result, inputTokens: result.inputTokens || estimateInputTokens(emergency.conversation.summary, emergency.messages, current, this.config.imageTokens) };
      } catch (retryError) {
        if (this.model.isContextLengthError(retryError)) throw new ContextLimitError("context remains too large after emergency compaction");
        throw retryError;
      }
    }
  }

  private load(accountId: string, peerId: string) {
    const conversation = this.store.getConversation(accountId, peerId);
    return { conversation, messages: this.store.listMessagesAfter(accountId, peerId, conversation.summaryThroughMessageId) };
  }

  private async compact(accountId: string, peerId: string, context: { conversation: Conversation; messages: StoredMessage[] }, keep: number, emergency = false) {
    const split = Math.max(0, context.messages.length - keep);
    const oldMessages = context.messages.slice(0, split);
    if (oldMessages.length === 0) {
      if (emergency) throw new ContextLimitError("no persisted history can be compacted");
      return context;
    }
    try {
      const summary = await this.model.summarize(context.conversation.summary, oldMessages, this.config.summaryMaxTokens);
      const throughId = oldMessages.at(-1)!.id;
      this.store.updateSummary(accountId, peerId, summary, throughId);
      return this.load(accountId, peerId);
    } catch (error) {
      if (error instanceof ContextLimitError) throw error;
      throw new ContextCompactionError("failed to create rolling summary", { cause: error });
    }
  }
}

export function estimateInputTokens(summary: string, history: StoredMessage[], current: CurrentInput, imageTokens: number): number {
  const text = [summary, ...history.map((message) => message.text), current.text].join("\n");
  return Math.ceil(Buffer.byteLength(text, "utf8") / 3) + current.images.length * imageTokens + 512;
}
