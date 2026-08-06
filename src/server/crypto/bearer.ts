import { Buffer } from "node:buffer"
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { z } from "zod"

import { type BearerHash, BearerHashSchema } from "../config/config"

const WebhookBearerSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/)
  .brand("WebhookBearer")
const BearerLastFourSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{4}$/)
  .brand("BearerLastFour")

export type WebhookBearer = z.infer<typeof WebhookBearerSchema>
export type BearerLastFour = z.infer<typeof BearerLastFourSchema>
export type WebhookBearerCredential = Readonly<{
  bearer: WebhookBearer
  hash: BearerHash
  lastFour: BearerLastFour
}>

export function hashBearer(bearer: string): BearerHash {
  return BearerHashSchema.parse(createHash("sha256").update(bearer, "utf8").digest("hex"))
}

export function generateWebhookBearer(): WebhookBearerCredential {
  const bearer = WebhookBearerSchema.parse(randomBytes(32).toString("base64url"))
  return Object.freeze({
    bearer,
    hash: hashBearer(bearer),
    lastFour: BearerLastFourSchema.parse(bearer.slice(-4)),
  })
}

export function verifyBearer(candidate: string, expectedHash: BearerHash): boolean {
  const candidateHash = Buffer.from(hashBearer(candidate), "hex")
  const storedHash = Buffer.from(expectedHash, "hex")
  return timingSafeEqual(candidateHash, storedHash)
}
