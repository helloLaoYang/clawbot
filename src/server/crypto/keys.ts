import { Buffer } from "node:buffer"
import { createHash, createSecretKey, hkdfSync, type KeyObject } from "node:crypto"

import type { AppEncryptionKey } from "../config/config"

const HKDF_INFOS = {
  cursorHmac: "clawbot:v1:cursor-hmac",
  fieldEncryption: "clawbot:v1:field-encryption",
  lookupHmac: "clawbot:v1:lookup-hmac",
} as const
const HKDF_SALT = createHash("sha256").update("clawbot:v1", "utf8").digest()

export type DerivedCryptoKeys = Readonly<{
  cursorHmac: KeyObject
  fieldEncryption: KeyObject
  lookupHmac: KeyObject
}>

function deriveKey(rootKey: Buffer, info: (typeof HKDF_INFOS)[keyof typeof HKDF_INFOS]): KeyObject {
  const bytes = hkdfSync("sha256", rootKey, HKDF_SALT, Buffer.from(info, "utf8"), 32)
  return createSecretKey(Buffer.from(bytes))
}

export function deriveCryptoKeys(rootKey: AppEncryptionKey): DerivedCryptoKeys {
  const decodedRootKey = Buffer.from(rootKey, "base64")
  return Object.freeze({
    cursorHmac: deriveKey(decodedRootKey, HKDF_INFOS.cursorHmac),
    fieldEncryption: deriveKey(decodedRootKey, HKDF_INFOS.fieldEncryption),
    lookupHmac: deriveKey(decodedRootKey, HKDF_INFOS.lookupHmac),
  })
}
