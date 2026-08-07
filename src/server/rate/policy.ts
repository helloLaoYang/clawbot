import { type EpochMilliseconds, EpochMillisecondsSchema } from "../db/ids"

const MILLISECONDS_PER_MINUTE = 60_000
const MINIMUM_RETRY_AFTER_MS = 1_000
const MAXIMUM_COOLDOWN_MS = 900_000
const BASE_COOLDOWN_MS = 60_000

export type EligibilityInput = {
  readonly retryNotBefore: EpochMilliseconds
  readonly cooldownUntil: EpochMilliseconds
  readonly nextEligibleAt: EpochMilliseconds
  readonly lastAttemptAt: EpochMilliseconds | null
  readonly intervalMs: number
}

export type Eligibility = {
  readonly effectiveNextEligibleAt: EpochMilliseconds
  readonly rateEligibleAt: EpochMilliseconds
  readonly eligibleAt: EpochMilliseconds
}

export type CooldownInput = {
  readonly now: EpochMilliseconds
  readonly retryAfter: string | null
  readonly cooldownUntil: EpochMilliseconds
  readonly consecutiveRateLimits: number
}

export type Cooldown = {
  readonly cooldownUntil: EpochMilliseconds
  readonly consecutiveRateLimits: number
}

export function calculateRateInterval(configured: number, currentCeiling: number): number {
  return Math.ceil(MILLISECONDS_PER_MINUTE / Math.min(configured, currentCeiling))
}

export function calculateEligibility(input: EligibilityInput): Eligibility {
  const intervalBoundary = input.lastAttemptAt === null ? 0 : input.lastAttemptAt + input.intervalMs
  const effectiveNextEligibleAt = EpochMillisecondsSchema.parse(
    Math.max(input.nextEligibleAt, intervalBoundary),
  )
  const rateEligibleAt = EpochMillisecondsSchema.parse(
    Math.max(input.cooldownUntil, effectiveNextEligibleAt),
  )
  return {
    effectiveNextEligibleAt,
    rateEligibleAt,
    eligibleAt: EpochMillisecondsSchema.parse(Math.max(input.retryNotBefore, rateEligibleAt)),
  }
}

export function calculateAdmissionEstimate(
  now: EpochMilliseconds,
  nextEligibleAt: EpochMilliseconds,
  cooldownUntil: EpochMilliseconds,
  tailEstimatedAt: EpochMilliseconds | null,
  intervalMs: number,
): EpochMilliseconds {
  const tailBoundary = tailEstimatedAt === null ? 0 : tailEstimatedAt + intervalMs
  return EpochMillisecondsSchema.parse(Math.max(now, nextEligibleAt, cooldownUntil, tailBoundary))
}

export function calculateAdmissionRetryAfter(
  estimatedAt: EpochMilliseconds,
  now: EpochMilliseconds,
): number {
  return Math.min(60, Math.max(1, Math.ceil(Math.max(1_000, estimatedAt - now) / 1_000)))
}

export function calculateTerminalRateRetryAfter(
  eligibleAt: EpochMilliseconds,
  now: EpochMilliseconds,
): number {
  return Math.max(1, Math.ceil((eligibleAt - now) / 1_000))
}

export function calculateCooldown(input: CooldownInput): Cooldown {
  const parsedDelay = parseRetryAfterDelay(input.retryAfter, input.now)
  const fallbackDelay = Math.min(
    BASE_COOLDOWN_MS * 2 ** Math.min(input.consecutiveRateLimits, 4),
    MAXIMUM_COOLDOWN_MS,
  )
  const delay = parsedDelay ?? fallbackDelay
  return {
    cooldownUntil: EpochMillisecondsSchema.parse(Math.max(input.cooldownUntil, input.now + delay)),
    consecutiveRateLimits: input.consecutiveRateLimits + 1,
  }
}

function parseRetryAfterDelay(retryAfter: string | null, now: EpochMilliseconds): number | null {
  if (retryAfter === null) {
    return null
  }
  const value = retryAfter.trim()
  if (/^\d+$/.test(value)) {
    const seconds = BigInt(value)
    if (seconds === 0n) {
      return null
    }
    if (seconds >= 900n) {
      return MAXIMUM_COOLDOWN_MS
    }
    return Math.max(MINIMUM_RETRY_AFTER_MS, Number(seconds) * 1_000)
  }
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp) || timestamp <= now) {
    return null
  }
  return Math.min(MAXIMUM_COOLDOWN_MS, Math.max(MINIMUM_RETRY_AFTER_MS, timestamp - now))
}
