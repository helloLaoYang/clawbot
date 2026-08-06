import { Buffer } from "node:buffer"
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { z } from "zod"

import { decodeCanonicalBase64Url, encodeBase64Url } from "./encoding"
import type { DerivedCryptoKeys } from "./keys"

const ALGORITHM = "aes-256-gcm" as const
const NONCE_BYTES = 12
const TAG_BYTES = 16

export type FieldContext = Readonly<{
  column: string
  rowUuid: string
  table: string
}>

type EnvelopeParts = Readonly<{
  ciphertext: Buffer
  nonce: Buffer
  tag: Buffer
}>

export const EncryptedEnvelopeSchema = z
  .string()
  .refine((value) => decodeEnvelope(value) !== null)
  .brand("EncryptedEnvelope")
export type EncryptedEnvelope = z.infer<typeof EncryptedEnvelopeSchema>

export type EnvelopeFailure = "authentication_failed" | "malformed"

export class EnvelopeError extends Error {
  readonly name = "EnvelopeError"

  constructor(readonly reason: EnvelopeFailure) {
    super(`Encrypted field could not be opened: ${reason}`)
  }
}

function createAad(context: FieldContext): Buffer {
  return Buffer.from(`clawbot:v1|${context.table}|${context.rowUuid}|${context.column}`, "utf8")
}

function decodeEnvelope(value: string): EnvelopeParts | null {
  const [version, nonceValue, ciphertextValue, tagValue, extra] = value.split(".")
  if (
    version !== "v1" ||
    nonceValue === undefined ||
    ciphertextValue === undefined ||
    tagValue === undefined ||
    extra !== undefined
  ) {
    return null
  }

  const nonce = decodeCanonicalBase64Url(nonceValue, NONCE_BYTES)
  const ciphertext = decodeCanonicalBase64Url(ciphertextValue)
  const tag = decodeCanonicalBase64Url(tagValue, TAG_BYTES)
  if (nonce === null || ciphertext === null || tag === null) {
    return null
  }
  return { ciphertext, nonce, tag }
}

export function encryptField(
  plaintext: string,
  context: FieldContext,
  keys: DerivedCryptoKeys,
): EncryptedEnvelope {
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv(ALGORITHM, keys.fieldEncryption, nonce, {
    authTagLength: TAG_BYTES,
  })
  cipher.setAAD(createAad(context))
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const envelope = `v1.${encodeBase64Url(nonce)}.${encodeBase64Url(ciphertext)}.${encodeBase64Url(cipher.getAuthTag())}`
  return EncryptedEnvelopeSchema.parse(envelope)
}

export function decryptField(
  envelope: string,
  context: FieldContext,
  keys: DerivedCryptoKeys,
): string {
  const parts = decodeEnvelope(envelope)
  if (parts === null) {
    throw new EnvelopeError("malformed")
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, keys.fieldEncryption, parts.nonce, {
      authTagLength: TAG_BYTES,
    })
    decipher.setAAD(createAad(context))
    decipher.setAuthTag(parts.tag)
    return Buffer.concat([decipher.update(parts.ciphertext), decipher.final()]).toString("utf8")
  } catch (error) {
    if (error instanceof Error) {
      throw new EnvelopeError("authentication_failed")
    }
    throw error
  }
}
