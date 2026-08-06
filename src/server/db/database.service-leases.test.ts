// @vitest-environment node

import { randomUUID } from "node:crypto"

import { describe, expect, it } from "vitest"

import { EpochMillisecondsSchema } from "./ids"
import { createTestDatabase, openTestDatabase } from "./test-support/fixtures"

const epoch = (value: number) => EpochMillisecondsSchema.parse(value)

describe("database leases", () => {
  it("refuses to replace an active service lease", () => {
    // Given: one process owns the active singleton lease.
    const testDatabase = createTestDatabase("task-4-service-lease-active")
    const first = openTestDatabase(testDatabase.path)
    const second = openTestDatabase(testDatabase.path)
    const firstOwner = randomUUID()
    const acquired = first.runtime.acquireServiceLease({
      ownerId: firstOwner,
      now: epoch(1_800_000_000_000),
      expiresAt: epoch(1_800_000_015_000),
    })

    try {
      // When: a second process tries to acquire before expiry.
      const contender = second.runtime.acquireServiceLease({
        ownerId: randomUUID(),
        now: epoch(1_800_000_005_000),
        expiresAt: epoch(1_800_000_020_000),
      })

      // Then: the contender loses and the first owner retains fence 1.
      expect(contender).toBeNull()
      expect(acquired).toMatchObject({ ownerId: firstOwner, fencingToken: 1 })
      expect(second.runtime.getServiceLease()).toEqual(acquired)
    } finally {
      second.close()
      first.close()
      testDatabase.cleanup()
    }
  })

  it("increments the fencing token when an expired service lease is acquired", () => {
    // Given: a first-generation lease at its exact expiry boundary.
    const testDatabase = createTestDatabase("task-4-service-lease-expired")
    const first = openTestDatabase(testDatabase.path)
    const second = openTestDatabase(testDatabase.path)
    first.runtime.acquireServiceLease({
      ownerId: randomUUID(),
      now: epoch(1_800_000_000_000),
      expiresAt: epoch(1_800_000_015_000),
    })
    const secondOwner = randomUUID()

    try {
      // When: another process acquires at expiry.
      const acquired = second.runtime.acquireServiceLease({
        ownerId: secondOwner,
        now: epoch(1_800_000_015_000),
        expiresAt: epoch(1_800_000_030_000),
      })

      // Then: ownership changes under a new monotonically increasing fence.
      expect(acquired).toMatchObject({ ownerId: secondOwner, fencingToken: 2 })
    } finally {
      second.close()
      first.close()
      testDatabase.cleanup()
    }
  })

  it("renews an active service lease only for its matching owner and fence", () => {
    // Given: an active first-generation service lease.
    const testDatabase = createTestDatabase("task-4-service-lease-renew")
    const handle = openTestDatabase(testDatabase.path)
    const ownerId = randomUUID()
    handle.runtime.acquireServiceLease({
      ownerId,
      now: epoch(1_800_000_000_000),
      expiresAt: epoch(1_800_000_015_000),
    })

    try {
      // When: its owner heartbeats with the current fencing token.
      const renewed = handle.runtime.renewServiceLease({
        ownerId,
        fencingToken: 1,
        now: epoch(1_800_000_005_000),
        expiresAt: epoch(1_800_000_020_000),
      })

      // Then: the compare-and-swap succeeds without changing the fence.
      expect(renewed).toBe(true)
      expect(handle.runtime.getServiceLease()).toMatchObject({
        ownerId,
        fencingToken: 1,
        expiresAt: 1_800_000_020_000,
      })
    } finally {
      handle.close()
      testDatabase.cleanup()
    }
  })

  it("rejects renewal from a stale service lease owner", () => {
    // Given: an expired first owner has been fenced out by a second owner.
    const testDatabase = createTestDatabase("task-4-service-lease-stale")
    const handle = openTestDatabase(testDatabase.path)
    const staleOwner = randomUUID()
    handle.runtime.acquireServiceLease({
      ownerId: staleOwner,
      now: epoch(1_800_000_000_000),
      expiresAt: epoch(1_800_000_015_000),
    })
    const currentOwner = randomUUID()
    const current = handle.runtime.acquireServiceLease({
      ownerId: currentOwner,
      now: epoch(1_800_000_015_000),
      expiresAt: epoch(1_800_000_030_000),
    })

    try {
      // When: the stale owner heartbeats with its old fence.
      const renewed = handle.runtime.renewServiceLease({
        ownerId: staleOwner,
        fencingToken: 1,
        now: epoch(1_800_000_016_000),
        expiresAt: epoch(1_800_000_031_000),
      })

      // Then: the write is rejected and current ownership is untouched.
      expect(renewed).toBe(false)
      expect(handle.runtime.getServiceLease()).toEqual(current)
    } finally {
      handle.close()
      testDatabase.cleanup()
    }
  })
})
