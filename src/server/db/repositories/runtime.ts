import { and, eq, gt, lte, sql } from "drizzle-orm"

import type {
  AcquireServiceLeaseInput,
  AdminLoginState,
  RenewServiceLeaseInput,
  ServiceLease,
} from "../contracts"
import { adminLoginState, serviceLease } from "../schema"
import type { ClawbotDatabase } from "../types"
import type { RuntimeRepository } from "./contracts"

export class DatabaseStateError extends Error {
  readonly name = "DatabaseStateError"
}

export class DrizzleRuntimeRepository implements RuntimeRepository {
  constructor(private readonly database: ClawbotDatabase) {}

  getServiceLease(): ServiceLease | null {
    const row = this.database
      .select()
      .from(serviceLease)
      .where(eq(serviceLease.name, "primary"))
      .get()
    return row ?? null
  }

  acquireServiceLease(input: AcquireServiceLeaseInput): ServiceLease | null {
    return this.database.transaction(
      (transaction) => {
        const acquired = transaction
          .insert(serviceLease)
          .values({
            name: "primary",
            ownerId: input.ownerId,
            fencingToken: 1,
            expiresAt: input.expiresAt,
            updatedAt: input.now,
          })
          .onConflictDoUpdate({
            target: serviceLease.name,
            set: {
              ownerId: input.ownerId,
              fencingToken: sql`${serviceLease.fencingToken} + 1`,
              expiresAt: input.expiresAt,
              updatedAt: input.now,
            },
            setWhere: lte(serviceLease.expiresAt, input.now),
          })
          .returning()
          .get()
        return acquired ?? null
      },
      { behavior: "immediate" },
    )
  }

  renewServiceLease(input: RenewServiceLeaseInput): boolean {
    return this.database.transaction(
      (transaction) => {
        const result = transaction
          .update(serviceLease)
          .set({ expiresAt: input.expiresAt, updatedAt: input.now })
          .where(
            and(
              eq(serviceLease.name, "primary"),
              eq(serviceLease.ownerId, input.ownerId),
              eq(serviceLease.fencingToken, input.fencingToken),
              gt(serviceLease.expiresAt, input.now),
            ),
          )
          .run()
        return result.changes === 1
      },
      { behavior: "immediate" },
    )
  }

  getAdminLoginState(): AdminLoginState {
    const row = this.database.select().from(adminLoginState).where(eq(adminLoginState.id, 1)).get()
    if (row === undefined) {
      throw new DatabaseStateError("admin login state is missing")
    }
    return {
      failedAttempts: row.failedAttempts,
      windowStartedAt: row.windowStartedAt,
      lockedUntil: row.lockedUntil,
      updatedAt: row.updatedAt,
    }
  }

  saveAdminLoginState(state: AdminLoginState): void {
    this.database.transaction(
      (transaction) =>
        transaction
          .insert(adminLoginState)
          .values({ id: 1, ...state })
          .onConflictDoUpdate({
            target: adminLoginState.id,
            set: state,
          })
          .run(),
      { behavior: "immediate" },
    )
  }
}
