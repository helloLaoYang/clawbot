import { eq } from "drizzle-orm"

import type { AdminLoginState, ServiceLease } from "../contracts"
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

  saveServiceLease(lease: ServiceLease): void {
    this.database.transaction(
      (transaction) =>
        transaction
          .insert(serviceLease)
          .values(lease)
          .onConflictDoUpdate({
            target: serviceLease.name,
            set: {
              ownerId: lease.ownerId,
              fencingToken: lease.fencingToken,
              expiresAt: lease.expiresAt,
              updatedAt: lease.updatedAt,
            },
          })
          .run(),
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
