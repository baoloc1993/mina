// Ký gói: Ed25519 trên 32 byte SHA-256 của file zip (không phải chuỗi hex). Khoá công khai lưu base64 của 32 byte thô.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { RegistryError } from "./errors.ts";

export const sha256 = (bytes: Uint8Array): Buffer => createHash("sha256").update(bytes).digest();

export function publicKeyB64(pub: KeyObject): string {
  return pub.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
}

export function generateKeyFile(path: string): string {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  return publicKeyB64(publicKey);
}

export function loadPrivateKey(path: string | undefined): KeyObject {
  if (!path) throw new RegistryError("SIGNING_KEY_MISSING", "chưa đặt SIGNING_KEY_PATH — chạy `npm run registry -- keygen` để sinh khoá thử");
  try {
    return createPrivateKey(readFileSync(path));
  } catch {
    throw new RegistryError("SIGNING_KEY_MISSING", `không đọc được khoá ký ở ${path}`);
  }
}

export const signDigest = (priv: KeyObject, digest: Buffer): string => sign(null, digest, priv).toString("base64");

export function verifyDigest(publicB64: string, digest: Buffer, signatureB64: string): boolean {
  const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(publicB64, "base64")]);
  return verify(null, digest, createPublicKey({ key: der, format: "der", type: "spki" }), Buffer.from(signatureB64, "base64"));
}

export const publicOf = (priv: KeyObject): string => publicKeyB64(createPublicKey(priv));
