import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

export class SecretBox {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error("SecretBox key must be 32 bytes");
  }

  encrypt(plainText: string, aad: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(aad));
    const ciphertext = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
  }

  decrypt(envelope: string, aad: string): string {
    const [version, ivText, tagText, ciphertextText] = envelope.split(".");
    if (version !== "v1" || !ivText || !tagText || ciphertextText === undefined) throw new Error("Invalid encrypted value");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(ivText, "base64url"));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertextText, "base64url")), decipher.final()]).toString("utf8");
  }
}

export function safeTokenEqual(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
