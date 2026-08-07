import { desc, eq } from "drizzle-orm"

import type { BotRecord, CreateBotInput, FieldCipher } from "../contracts"
import type {
  ConfirmQrBotInput,
  ConfirmQrBotResult,
  QrBotRepository,
  ReloginQrBotInput,
} from "../qr-contracts"
import { botSecrets, bots, inboundState, rateState } from "../schema"
import type { ClawbotDatabase } from "../types"

export class DrizzleQrBotRepository implements QrBotRepository {
  constructor(
    private readonly database: ClawbotDatabase,
    private readonly cipher: FieldCipher,
  ) {}

  confirm(input: ConfirmQrBotInput): ConfirmQrBotResult {
    return this.database.transaction(
      (transaction) => {
        switch (input.kind) {
          case "new": {
            const existing = transaction
              .select({ id: bots.id })
              .from(bots)
              .where(eq(bots.ilinkBotIdLookupHash, input.bot.ilinkBotIdLookupHash))
              .get()
            if (existing !== undefined) {
              return { kind: "invalid_state" }
            }
            this.insertNewBot(transaction, input.bot)
            return { bot: this.newBotRecord(input.bot), kind: "confirmed" }
          }
          case "relogin": {
            const current = transaction
              .select()
              .from(bots)
              .where(eq(bots.id, input.bot.botId))
              .get()
            if (
              current === undefined ||
              current.ilinkBotIdLookupHash !== input.bot.ilinkBotIdLookupHash
            ) {
              return { kind: "invalid_state" }
            }
            transaction
              .update(bots)
              .set({
                accountFingerprint: input.bot.accountFingerprint,
                authStatus: "active",
                boundUserFingerprint: input.bot.boundUserFingerprint,
                ilinkBotIdEncrypted: this.encryptBotId(input.bot),
                ilinkUserIdEncrypted: this.encryptUserId(input.bot),
                updatedAt: input.bot.now,
              })
              .where(eq(bots.id, input.bot.botId))
              .run()
            transaction
              .update(botSecrets)
              .set({
                baseUrl: input.bot.baseUrl,
                botTokenEncrypted: this.encryptBotToken(input.bot),
                updatedAt: input.bot.now,
              })
              .where(eq(botSecrets.botId, input.bot.botId))
              .run()
            return {
              bot: {
                accountFingerprint: input.bot.accountFingerprint,
                authStatus: "active",
                boundUserFingerprint: input.bot.boundUserFingerprint,
                createdAt: current.createdAt,
                enabled: current.enabled,
                id: current.id,
                ilinkBotId: input.bot.ilinkBotId,
                ilinkUserId: input.bot.ilinkUserId,
                maxSendsPerMinute: current.maxSendsPerMinute,
                publicId: current.publicId,
                remark: current.remark,
                updatedAt: input.bot.now,
              },
              kind: "confirmed",
            }
          }
          default:
            return this.assertNever(input)
        }
      },
      { behavior: "immediate" },
    )
  }

  listLocalCredentials() {
    return this.database
      .select({
        botId: botSecrets.botId,
        botTokenEncrypted: botSecrets.botTokenEncrypted,
        updatedAt: botSecrets.updatedAt,
      })
      .from(botSecrets)
      .orderBy(desc(botSecrets.updatedAt))
      .limit(10)
      .all()
      .map((row) => ({
        botToken: this.cipher.decrypt({
          ciphertext: row.botTokenEncrypted,
          column: "bot_token_encrypted",
          rowId: row.botId,
          table: "bot_secrets",
        }),
        updatedAt: row.updatedAt,
      }))
  }

  private insertNewBot(
    transaction: Parameters<Parameters<ClawbotDatabase["transaction"]>[0]>[0],
    input: CreateBotInput,
  ): void {
    transaction
      .insert(bots)
      .values({
        accountFingerprint: input.accountFingerprint,
        authStatus: input.authStatus,
        boundUserFingerprint: input.boundUserFingerprint,
        createdAt: input.now,
        enabled: input.enabled,
        id: input.id,
        ilinkBotIdEncrypted: this.encryptBotId(input),
        ilinkBotIdLookupHash: input.ilinkBotIdLookupHash,
        ilinkUserIdEncrypted: this.encryptUserId(input),
        maxSendsPerMinute: input.maxSendsPerMinute,
        publicId: input.publicId,
        remark: input.remark,
        updatedAt: input.now,
      })
      .run()
    transaction
      .insert(botSecrets)
      .values({
        baseUrl: input.baseUrl,
        botId: input.id,
        botTokenEncrypted: this.encryptBotToken(input),
        createdAt: input.now,
        updatedAt: input.now,
        webhookBearerHash: input.webhookBearerHash,
        webhookBearerLastFour: input.webhookBearerLastFour,
      })
      .run()
    transaction.insert(inboundState).values({ botId: input.id, updatedAt: input.now }).run()
    transaction.insert(rateState).values({ botId: input.id, updatedAt: input.now }).run()
  }

  private encryptBotId(input: Pick<CreateBotInput, "id" | "ilinkBotId"> | ReloginQrBotInput) {
    return this.cipher.encrypt({
      column: "ilink_bot_id_encrypted",
      plaintext: input.ilinkBotId,
      rowId: "id" in input ? input.id : input.botId,
      table: "bots",
    })
  }

  private encryptUserId(input: Pick<CreateBotInput, "id" | "ilinkUserId"> | ReloginQrBotInput) {
    return this.cipher.encrypt({
      column: "ilink_user_id_encrypted",
      plaintext: input.ilinkUserId,
      rowId: "id" in input ? input.id : input.botId,
      table: "bots",
    })
  }

  private encryptBotToken(input: Pick<CreateBotInput, "id" | "botToken"> | ReloginQrBotInput) {
    return this.cipher.encrypt({
      column: "bot_token_encrypted",
      plaintext: input.botToken,
      rowId: "id" in input ? input.id : input.botId,
      table: "bot_secrets",
    })
  }

  private newBotRecord(input: CreateBotInput): BotRecord {
    return {
      accountFingerprint: input.accountFingerprint,
      authStatus: input.authStatus,
      boundUserFingerprint: input.boundUserFingerprint,
      createdAt: input.now,
      enabled: input.enabled,
      id: input.id,
      ilinkBotId: input.ilinkBotId,
      ilinkUserId: input.ilinkUserId,
      maxSendsPerMinute: input.maxSendsPerMinute,
      publicId: input.publicId,
      remark: input.remark,
      updatedAt: input.now,
    }
  }

  private assertNever(value: never): never {
    return value
  }
}
