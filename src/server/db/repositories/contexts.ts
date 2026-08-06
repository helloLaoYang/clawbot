import { and, eq } from "drizzle-orm"

import type { ConversationContext, FieldCipher, UpsertContextInput } from "../contracts"
import type { BotId } from "../ids"
import { conversationContexts } from "../schema"
import type { ClawbotDatabase } from "../types"
import type { ConversationRepository } from "./contracts"

export class DrizzleConversationRepository implements ConversationRepository {
  constructor(
    private readonly database: ClawbotDatabase,
    private readonly cipher: FieldCipher,
  ) {}

  upsert(input: UpsertContextInput): ConversationContext {
    return this.database.transaction(
      (transaction) => {
        const existing = transaction
          .select({ id: conversationContexts.id, createdAt: conversationContexts.createdAt })
          .from(conversationContexts)
          .where(
            and(
              eq(conversationContexts.botId, input.botId),
              eq(conversationContexts.userLookupHash, input.userLookupHash),
            ),
          )
          .get()
        const id = existing?.id ?? input.id
        const createdAt = existing?.createdAt ?? input.now
        const userIdEncrypted = this.cipher.encrypt({
          table: "conversation_contexts",
          rowId: id,
          column: "user_id_encrypted",
          plaintext: input.userId,
        })
        const contextTokenEncrypted = this.cipher.encrypt({
          table: "conversation_contexts",
          rowId: id,
          column: "context_token_encrypted",
          plaintext: input.contextToken,
        })
        transaction
          .insert(conversationContexts)
          .values({
            id,
            botId: input.botId,
            userIdEncrypted,
            userLookupHash: input.userLookupHash,
            userFingerprint: input.userFingerprint,
            contextTokenEncrypted,
            createdAt,
            updatedAt: input.now,
          })
          .onConflictDoUpdate({
            target: [conversationContexts.botId, conversationContexts.userLookupHash],
            set: {
              userIdEncrypted,
              userFingerprint: input.userFingerprint,
              contextTokenEncrypted,
              updatedAt: input.now,
            },
          })
          .run()
        return { ...input, id, createdAt, updatedAt: input.now }
      },
      { behavior: "immediate" },
    )
  }

  find(botId: BotId, userLookupHash: string): ConversationContext | null {
    const row = this.database
      .select()
      .from(conversationContexts)
      .where(
        and(
          eq(conversationContexts.botId, botId),
          eq(conversationContexts.userLookupHash, userLookupHash),
        ),
      )
      .get()
    if (row === undefined) {
      return null
    }
    return {
      id: row.id,
      botId: row.botId,
      userId: this.cipher.decrypt({
        table: "conversation_contexts",
        rowId: row.id,
        column: "user_id_encrypted",
        ciphertext: row.userIdEncrypted,
      }),
      userLookupHash: row.userLookupHash,
      userFingerprint: row.userFingerprint,
      contextToken: this.cipher.decrypt({
        table: "conversation_contexts",
        rowId: row.id,
        column: "context_token_encrypted",
        ciphertext: row.contextTokenEncrypted,
      }),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }
}
