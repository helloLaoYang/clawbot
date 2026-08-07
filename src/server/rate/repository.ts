import { eq } from "drizzle-orm"

import type { RateStateRecord } from "../db/contracts"
import { type BotId, type EpochMilliseconds, EpochMillisecondsSchema } from "../db/ids"
import { rateState } from "../db/schema"
import type { ClawbotDatabase } from "../db/types"
import { calculateCooldown } from "./policy"

export type QueueTransaction = Parameters<Parameters<ClawbotDatabase["transaction"]>[0]>[0]

const ZERO_EPOCH = EpochMillisecondsSchema.parse(0)

export class RateStateMissingError extends Error {
  readonly name = "RateStateMissingError"

  constructor(readonly botId: BotId) {
    super(`rate state missing for bot ${botId}`)
  }
}

export class TransactionalRateRepository {
  constructor(private readonly transaction: QueueTransaction) {}

  get(botId: BotId): RateStateRecord {
    const row = this.transaction.select().from(rateState).where(eq(rateState.botId, botId)).get()
    if (row === undefined) {
      throw new RateStateMissingError(botId)
    }
    return row
  }

  projectNextEligible(
    state: RateStateRecord,
    nextEligibleAt: EpochMilliseconds,
    now: EpochMilliseconds,
  ): RateStateRecord {
    if (nextEligibleAt <= state.nextEligibleAt) {
      return state
    }
    this.transaction
      .update(rateState)
      .set({ nextEligibleAt, updatedAt: now })
      .where(eq(rateState.botId, state.botId))
      .run()
    return { ...state, nextEligibleAt, updatedAt: now }
  }

  reserveSlot(
    state: RateStateRecord,
    now: EpochMilliseconds,
    nextEligibleAt: EpochMilliseconds,
  ): RateStateRecord {
    this.transaction
      .update(rateState)
      .set({ lastAttemptAt: now, nextEligibleAt, updatedAt: now })
      .where(eq(rateState.botId, state.botId))
      .run()
    return { ...state, lastAttemptAt: now, nextEligibleAt, updatedAt: now }
  }

  recordRateLimit(
    state: RateStateRecord,
    now: EpochMilliseconds,
    retryAfter: string | null,
  ): RateStateRecord {
    const cooldown = calculateCooldown({
      now,
      retryAfter,
      cooldownUntil: state.cooldownUntil,
      consecutiveRateLimits: state.consecutiveRateLimits,
    })
    this.transaction
      .update(rateState)
      .set({
        cooldownUntil: cooldown.cooldownUntil,
        consecutiveRateLimits: cooldown.consecutiveRateLimits,
        updatedAt: now,
      })
      .where(eq(rateState.botId, state.botId))
      .run()
    return {
      ...state,
      cooldownUntil: cooldown.cooldownUntil,
      consecutiveRateLimits: cooldown.consecutiveRateLimits,
      updatedAt: now,
    }
  }

  resetRateLimit(state: RateStateRecord, now: EpochMilliseconds): RateStateRecord {
    this.transaction
      .update(rateState)
      .set({ cooldownUntil: ZERO_EPOCH, consecutiveRateLimits: 0, updatedAt: now })
      .where(eq(rateState.botId, state.botId))
      .run()
    return { ...state, cooldownUntil: ZERO_EPOCH, consecutiveRateLimits: 0, updatedAt: now }
  }
}
