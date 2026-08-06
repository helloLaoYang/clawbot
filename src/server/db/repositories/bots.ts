import { eq } from "drizzle-orm"

import type { BotCredentials, BotRecord, CreateBotInput, FieldCipher } from "../contracts"
import type { BotId, BotPublicId } from "../ids"
import { botSecrets, bots, inboundState, rateState } from "../schema"
import type { ClawbotDatabase } from "../types"
import type { BotRepository } from "./contracts"

export class DrizzleBotRepository implements BotRepository {
  constructor(
    private readonly database: ClawbotDatabase,
    private readonly cipher: FieldCipher,
  ) {}

  create(input: CreateBotInput): BotRecord {
    return this.database.transaction(
      (transaction) => {
        transaction
          .insert(bots)
          .values({
            id: input.id,
            publicId: input.publicId,
            accountFingerprint: input.accountFingerprint,
            ilinkBotIdLookupHash: input.ilinkBotIdLookupHash,
            boundUserFingerprint: input.boundUserFingerprint,
            ilinkBotIdEncrypted: this.cipher.encrypt({
              table: "bots",
              rowId: input.id,
              column: "ilink_bot_id_encrypted",
              plaintext: input.ilinkBotId,
            }),
            ilinkUserIdEncrypted: this.cipher.encrypt({
              table: "bots",
              rowId: input.id,
              column: "ilink_user_id_encrypted",
              plaintext: input.ilinkUserId,
            }),
            remark: input.remark,
            enabled: input.enabled,
            authStatus: input.authStatus,
            maxSendsPerMinute: input.maxSendsPerMinute,
            createdAt: input.now,
            updatedAt: input.now,
          })
          .run()
        transaction
          .insert(botSecrets)
          .values({
            botId: input.id,
            botTokenEncrypted: this.cipher.encrypt({
              table: "bot_secrets",
              rowId: input.id,
              column: "bot_token_encrypted",
              plaintext: input.botToken,
            }),
            baseUrl: input.baseUrl,
            webhookBearerHash: input.webhookBearerHash,
            webhookBearerLastFour: input.webhookBearerLastFour,
            createdAt: input.now,
            updatedAt: input.now,
          })
          .run()
        transaction.insert(inboundState).values({ botId: input.id, updatedAt: input.now }).run()
        transaction.insert(rateState).values({ botId: input.id, updatedAt: input.now }).run()
        return {
          id: input.id,
          publicId: input.publicId,
          accountFingerprint: input.accountFingerprint,
          boundUserFingerprint: input.boundUserFingerprint,
          ilinkBotId: input.ilinkBotId,
          ilinkUserId: input.ilinkUserId,
          remark: input.remark,
          enabled: input.enabled,
          authStatus: input.authStatus,
          maxSendsPerMinute: input.maxSendsPerMinute,
          createdAt: input.now,
          updatedAt: input.now,
        }
      },
      { behavior: "immediate" },
    )
  }

  findByPublicId(publicId: BotPublicId): BotRecord | null {
    const row = this.database.select().from(bots).where(eq(bots.publicId, publicId)).get()
    if (row === undefined) {
      return null
    }
    return this.mapBot(row)
  }

  findByUpstreamLookupHash(lookupHash: string): BotRecord | null {
    const row = this.database
      .select()
      .from(bots)
      .where(eq(bots.ilinkBotIdLookupHash, lookupHash))
      .get()
    if (row === undefined) {
      return null
    }
    return this.mapBot(row)
  }

  getCredentials(botId: BotId): BotCredentials | null {
    const row = this.database.select().from(botSecrets).where(eq(botSecrets.botId, botId)).get()
    if (row === undefined) {
      return null
    }
    return {
      botId: row.botId,
      botToken: this.cipher.decrypt({
        table: "bot_secrets",
        rowId: row.botId,
        column: "bot_token_encrypted",
        ciphertext: row.botTokenEncrypted,
      }),
      baseUrl: row.baseUrl,
      webhookBearerHash: row.webhookBearerHash,
      webhookBearerLastFour: row.webhookBearerLastFour,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }

  delete(botId: BotId): void {
    this.database.transaction(
      (transaction) => transaction.delete(bots).where(eq(bots.id, botId)).run(),
      { behavior: "immediate" },
    )
  }

  private mapBot(row: typeof bots.$inferSelect): BotRecord {
    return {
      id: row.id,
      publicId: row.publicId,
      accountFingerprint: row.accountFingerprint,
      boundUserFingerprint: row.boundUserFingerprint,
      ilinkBotId: this.cipher.decrypt({
        table: "bots",
        rowId: row.id,
        column: "ilink_bot_id_encrypted",
        ciphertext: row.ilinkBotIdEncrypted,
      }),
      ilinkUserId: this.cipher.decrypt({
        table: "bots",
        rowId: row.id,
        column: "ilink_user_id_encrypted",
        ciphertext: row.ilinkUserIdEncrypted,
      }),
      remark: row.remark,
      enabled: row.enabled,
      authStatus: row.authStatus,
      maxSendsPerMinute: row.maxSendsPerMinute,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }
}
