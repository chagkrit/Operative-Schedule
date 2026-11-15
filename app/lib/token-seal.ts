// SERVER-ONLY: AES-256-GCM sealing of Google refresh tokens before they are stored.
// The key (base64, 32 bytes) is passed in by the caller; this module never reads the environment
// and never logs. Format: v1.<b64 iv>.<b64 tag>.<b64 ciphertext>.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

function keyBytes(keyB64: string): Buffer {
  const key = Buffer.from(String(keyB64 ?? ""), "base64");
  if (key.length !== 32) throw new Error("token seal key must be 32 bytes (base64)");
  return key;
}

export function sealToken(plain: string, keyB64: string): string {
  const key = keyBytes(keyB64);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(".");
}

export function openToken(sealed: string, keyB64: string): string {
  const key = keyBytes(keyB64);
  const parts = String(sealed ?? "").split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error("sealed token has a bad format");
  const iv = Buffer.from(parts[1], "base64");
  const tag = Buffer.from(parts[2], "base64");
  const ct = Buffer.from(parts[3], "base64");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error("sealed token has a bad format");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
