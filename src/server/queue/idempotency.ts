import { createHash } from "node:crypto"

import type { BotPublicId } from "../db/ids"

const SINGLE_PREFIX = Buffer.from("clawbot-idem-v1:single", "ascii")
const BATCH_PREFIX = Buffer.from("clawbot-idem-v1:batch", "ascii")

export function hashIdempotencyKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex")
}

export function createSingleRequestDigest(recipient: string, text: string): string {
  return digest([SINGLE_PREFIX, lengthPrefix(recipient), lengthPrefix(text)])
}

export function createBatchRequestDigest(
  botPublicIds: readonly BotPublicId[],
  recipient: string,
  text: string,
): string {
  const count = Buffer.alloc(4)
  count.writeUInt32BE(botPublicIds.length)
  return digest([
    BATCH_PREFIX,
    count,
    ...botPublicIds.map(lengthPrefix),
    lengthPrefix(recipient),
    lengthPrefix(text),
  ])
}

function lengthPrefix(value: string): Buffer {
  const encoded = Buffer.from(value, "utf8")
  const length = Buffer.alloc(8)
  length.writeBigUInt64BE(BigInt(encoded.byteLength))
  return Buffer.concat([length, encoded])
}

function digest(parts: readonly Buffer[]): string {
  return createHash("sha256").update(Buffer.concat(parts)).digest("hex")
}
