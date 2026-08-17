import { createDecipheriv } from "node:crypto";
import { WEIXIN_CDN_BASE_URL, type ImageItem } from "./types.js";
import { trustedUrl, WeixinApiError } from "./api.js";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function decodeKey(item: ImageItem): Buffer {
  if (item.aeskey && /^[0-9a-f]{32}$/i.test(item.aeskey)) return Buffer.from(item.aeskey, "hex");
  const encoded = item.media?.aes_key ?? item.aeskey;
  if (!encoded) throw new WeixinApiError("Image encryption key is missing");
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.length === 16) return decoded;
  const text = decoded.toString("ascii");
  if (/^[0-9a-f]{32}$/i.test(text)) return Buffer.from(text, "hex");
  throw new WeixinApiError("Invalid image encryption key");
}

function imageMime(data: Buffer): string | null {
  if (data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (data.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) return "image/png";
  if (data.subarray(0, 6).toString("ascii").startsWith("GIF8")) return "image/gif";
  if (data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

export async function downloadImage(item: ImageItem): Promise<{ dataUrl: string; bytes: number }> {
  const rawUrl = item.media?.full_url ?? `${WEIXIN_CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(item.media?.encrypt_query_param ?? "")}`;
  trustedUrl(rawUrl);
  const response = await fetch(rawUrl, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new WeixinApiError(`Image CDN HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_IMAGE_BYTES) throw new WeixinApiError("Image exceeds 10 MiB");
  const encrypted = Buffer.from(await response.arrayBuffer());
  if (encrypted.length > MAX_IMAGE_BYTES) throw new WeixinApiError("Image exceeds 10 MiB");
  const decipher = createDecipheriv("aes-128-ecb", decodeKey(item), null);
  decipher.setAutoPadding(true);
  const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  const mime = imageMime(plain);
  if (!mime) throw new WeixinApiError("Unsupported or invalid image data");
  return { dataUrl: `data:${mime};base64,${plain.toString("base64")}`, bytes: plain.length };
}
