// @vitest-environment node

import { describe, expect, it } from "vitest"

import { DatabaseInvariantError } from "./database"
import { createTestDatabase, openTestDatabase } from "./test-support/fixtures"

class ExpectedStartupFailureError extends Error {
  readonly name = "ExpectedStartupFailureError"
}

function expectMigrationFailure(path: string): void {
  try {
    const unexpected = openTestDatabase(path)
    unexpected.close()
  } catch (error) {
    if (error instanceof DatabaseInvariantError) {
      expect(error.invariant).toBe("migration")
      return
    }
    throw error
  }
  throw new ExpectedStartupFailureError("expected migration startup failure")
}

describe("database migration integrity", () => {
  it("rejects a migration journal row with a forged hash", () => {
    // Given: a migrated database whose recorded migration hash was replaced.
    const testDatabase = createTestDatabase("task-4-migration-hash")
    const handle = openTestDatabase(testDatabase.path)
    handle.client.prepare("UPDATE __drizzle_migrations SET hash = ?").run("0".repeat(64))
    handle.close()

    try {
      // When/Then: startup rejects the journal before accepting the schema.
      expectMigrationFailure(testDatabase.path)
    } finally {
      testDatabase.cleanup()
    }
  })

  it("rejects a migration journal row with a forged timestamp", () => {
    // Given: a migrated database whose recorded migration timestamp was changed.
    const testDatabase = createTestDatabase("task-4-migration-timestamp")
    const handle = openTestDatabase(testDatabase.path)
    handle.client.prepare("UPDATE __drizzle_migrations SET created_at = created_at + 1").run()
    handle.close()

    try {
      // When/Then: startup rejects the journal instead of trusting its latest timestamp.
      expectMigrationFailure(testDatabase.path)
    } finally {
      testDatabase.cleanup()
    }
  })

  it("rejects schema drift after a migration was recorded", () => {
    // Given: a migrated database missing one durable table.
    const testDatabase = createTestDatabase("task-4-migration-schema")
    const handle = openTestDatabase(testDatabase.path)
    handle.client.exec("DROP TABLE service_lease")
    handle.close()

    try {
      // When/Then: startup classifies the mismatch as migration integrity failure.
      expectMigrationFailure(testDatabase.path)
    } finally {
      testDatabase.cleanup()
    }
  })
})
