import { Buffer } from "node:buffer"

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/

export function encodeBase64Url(value: Uint8Array | string): string {
  return Buffer.from(value).toString("base64url")
}

export function decodeCanonicalBase64Url(value: string, expectedBytes?: number): Buffer | null {
  if (!BASE64URL_PATTERN.test(value)) {
    return null
  }

  const decoded = Buffer.from(value, "base64url")
  if (decoded.toString("base64url") !== value) {
    return null
  }
  if (expectedBytes !== undefined && decoded.length !== expectedBytes) {
    return null
  }
  return decoded
}
