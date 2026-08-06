import { eq } from "drizzle-orm"

import type { FieldCipher, InboundStateRecord, RateStateRecord } from "../contracts"
import type { BotId } from "../ids"
import { inboundState, rateState } from "../schema"
import type { ClawbotDatabase } from "../types"
import type { BotStateRepository } from "./contracts"

export class DrizzleBotStateRepository implements BotStateRepository {
  constructor(
    private readonly database: ClawbotDatabase,
    private readonly cipher: FieldCipher,
  ) {}

  getInbound(botId: BotId): InboundStateRecord | null {
    const row = this.database.select().from(inboundState).where(eq(inboundState.botId, botId)).get()
    if (row === undefined) {
      return null
    }
    return {
      botId: row.botId,
      cursor:
        row.cursorEncrypted === null
          ? null
          : this.cipher.decrypt({
              table: "inbound_state",
              rowId: row.botId,
              column: "cursor_encrypted",
              ciphertext: row.cursorEncrypted,
            }),
      lastPolledAt: row.lastPolledAt,
      updatedAt: row.updatedAt,
    }
  }

  saveInbound(state: InboundStateRecord): void {
    const cursorEncrypted =
      state.cursor === null
        ? null
        : this.cipher.encrypt({
            table: "inbound_state",
            rowId: state.botId,
            column: "cursor_encrypted",
            plaintext: state.cursor,
          })
    this.database.transaction(
      (transaction) =>
        transaction
          .insert(inboundState)
          .values({
            botId: state.botId,
            cursorEncrypted,
            lastPolledAt: state.lastPolledAt,
            updatedAt: state.updatedAt,
          })
          .onConflictDoUpdate({
            target: inboundState.botId,
            set: {
              cursorEncrypted,
              lastPolledAt: state.lastPolledAt,
              updatedAt: state.updatedAt,
            },
          })
          .run(),
      { behavior: "immediate" },
    )
  }

  getRate(botId: BotId): RateStateRecord | null {
    const row = this.database.select().from(rateState).where(eq(rateState.botId, botId)).get()
    return row ?? null
  }

  saveRate(state: RateStateRecord): void {
    this.database.transaction(
      (transaction) =>
        transaction
          .insert(rateState)
          .values(state)
          .onConflictDoUpdate({
            target: rateState.botId,
            set: {
              lastAttemptAt: state.lastAttemptAt,
              nextEligibleAt: state.nextEligibleAt,
              cooldownUntil: state.cooldownUntil,
              consecutiveRateLimits: state.consecutiveRateLimits,
              updatedAt: state.updatedAt,
            },
          })
          .run(),
      { behavior: "immediate" },
    )
  }
}
