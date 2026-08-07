import { and, eq, gt } from "drizzle-orm"

import type { EpochMilliseconds } from "../db/ids"
import { serviceLease } from "../db/schema"
import type { QueueTransaction } from "../rate/repository"
import type { ServiceFence } from "./contracts"

export function hasServiceFence(
  transaction: QueueTransaction,
  fence: ServiceFence,
  now: EpochMilliseconds,
): boolean {
  return (
    transaction
      .select({ name: serviceLease.name })
      .from(serviceLease)
      .where(
        and(
          eq(serviceLease.name, "primary"),
          eq(serviceLease.ownerId, fence.ownerId),
          eq(serviceLease.fencingToken, fence.fencingToken),
          gt(serviceLease.expiresAt, now),
        ),
      )
      .get() !== undefined
  )
}
