import { createHmac } from "node:crypto"
import { z } from "zod"

import type { DerivedCryptoKeys } from "./keys"

const LookupHashSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .brand("LookupHash")
const AccountFingerprintSchema = z
  .string()
  .regex(/^acct_[a-f0-9]{8}$/)
  .brand("AccountFingerprint")
const UserFingerprintSchema = z
  .string()
  .regex(/^user_[a-f0-9]{8}$/)
  .brand("UserFingerprint")

export type LookupHash = z.infer<typeof LookupHashSchema>
export type AccountFingerprint = z.infer<typeof AccountFingerprintSchema>
export type UserFingerprint = z.infer<typeof UserFingerprintSchema>

export function createLookupHash(value: string, keys: DerivedCryptoKeys): LookupHash {
  const digest = createHmac("sha256", keys.lookupHmac).update(value, "utf8").digest("hex")
  return LookupHashSchema.parse(digest)
}

export function createAccountFingerprint(
  accountId: string,
  keys: DerivedCryptoKeys,
): AccountFingerprint {
  return AccountFingerprintSchema.parse(`acct_${createLookupHash(accountId, keys).slice(0, 8)}`)
}

export function createUserFingerprint(userId: string, keys: DerivedCryptoKeys): UserFingerprint {
  return UserFingerprintSchema.parse(`user_${createLookupHash(userId, keys).slice(0, 8)}`)
}
