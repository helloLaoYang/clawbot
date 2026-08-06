import { Buffer } from "node:buffer"
import { createHmac, timingSafeEqual } from "node:crypto"
import { z } from "zod"

import { decodeCanonicalBase64Url, encodeBase64Url } from "./encoding"
import type { DerivedCryptoKeys } from "./keys"

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const CURSOR_PAYLOAD_PATTERN =
  /^([0-9]+):([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):([a-f0-9]{64})$/

const CursorPositionSchema = z
  .object({
    createdAt: z.number().int().nonnegative().safe(),
    id: z.string().regex(UUID_V4_PATTERN),
  })
  .readonly()
export const PaginationCursorSchema = z
  .string()
  .refine((value) => decodeCanonicalBase64Url(value) !== null)
  .brand("PaginationCursor")

export type CursorPosition = z.infer<typeof CursorPositionSchema>
export type PaginationCursor = z.infer<typeof PaginationCursorSchema>
export type CursorDecodeResult =
  | { readonly kind: "invalid"; readonly reason: "invalid_signature" | "malformed" }
  | { readonly kind: "valid"; readonly value: CursorPosition }

function createCursorSignature(payload: string, keys: DerivedCryptoKeys): Buffer {
  return createHmac("sha256", keys.cursorHmac).update(payload, "utf8").digest()
}

export function encodeCursor(position: CursorPosition, keys: DerivedCryptoKeys): PaginationCursor {
  const parsedPosition = CursorPositionSchema.parse(position)
  const payload = `${parsedPosition.createdAt}:${parsedPosition.id}`
  const signature = createCursorSignature(payload, keys).toString("hex")
  return PaginationCursorSchema.parse(encodeBase64Url(`${payload}:${signature}`))
}

export function decodeCursor(cursor: string, keys: DerivedCryptoKeys): CursorDecodeResult {
  const decoded = decodeCanonicalBase64Url(cursor)
  if (decoded === null) {
    return { kind: "invalid", reason: "malformed" }
  }

  const match = CURSOR_PAYLOAD_PATTERN.exec(decoded.toString("utf8"))
  const createdAtText = match?.at(1)
  const id = match?.at(2)
  const signatureText = match?.at(3)
  if (createdAtText === undefined || id === undefined || signatureText === undefined) {
    return { kind: "invalid", reason: "malformed" }
  }

  const createdAt = Number(createdAtText)
  if (!Number.isSafeInteger(createdAt) || createdAt < 0 || String(createdAt) !== createdAtText) {
    return { kind: "invalid", reason: "malformed" }
  }

  const payload = `${createdAtText}:${id}`
  const expectedSignature = createCursorSignature(payload, keys)
  const suppliedSignature = Buffer.from(signatureText, "hex")
  if (!timingSafeEqual(expectedSignature, suppliedSignature)) {
    return { kind: "invalid", reason: "invalid_signature" }
  }

  return { kind: "valid", value: CursorPositionSchema.parse({ createdAt, id }) }
}
