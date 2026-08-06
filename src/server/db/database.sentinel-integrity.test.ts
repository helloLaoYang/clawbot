// @vitest-environment node

import { describe, expect, it } from "vitest"

import { DatabaseInvariantError } from "./database"
import { createTestDatabase, openTestDatabase } from "./test-support/fixtures"

class ExpectedStartupFailureError extends Error {
  readonly name = "ExpectedStartupFailureError"
}

function expectMissingSentinelFailure(path: string): void {
  try {
    const unexpected = openTestDatabase(path)
    unexpected.close()
  } catch (error) {
    if (error instanceof DatabaseInvariantError) {
      expect(error.invariant).toBe("encryption_sentinel")
      return
    }
    throw error
  }
  throw new ExpectedStartupFailureError("expected encryption sentinel startup failure")
}

describe("database sentinel integrity", () => {
  it("rejects a missing sentinel row without reporting a key mismatch", () => {
    // Given: an existing migrated database whose sentinel row was deleted.
    const testDatabase = createTestDatabase("task-4-sentinel-missing")
    const handle = openTestDatabase(testDatabase.path)
    handle.client.exec("DELETE FROM encryption_sentinel")
    handle.close()

    try {
      // When/Then: startup reports the missing invariant instead of silently recreating it.
      expectMissingSentinelFailure(testDatabase.path)
    } finally {
      testDatabase.cleanup()
    }
  })
})
