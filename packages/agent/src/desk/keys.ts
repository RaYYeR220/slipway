// The desk's Ed25519 plan-signing key. SLIPWAY_SIGNING_KEY holds the base64 PKCS#8 private key (as produced by
// core's exportKeyPair) or a JSON {publicKey, privateKey}; the public key is derived, never configured separately.
// Without it a process-local key is generated outside production, so plans signed by one dev process verify only there.
import { exportPublicKey, generateSigningKeys, importKeyPair } from "@slipway/core";

export interface DeskKeys {
  keys: CryptoKeyPair;
  publicKey: string; // base64 raw Ed25519
  origin: "env" | "ephemeral";
}

const b64urlToB64 = (s: string) =>
  s
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(s.length / 4) * 4, "=");
const fromB64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

export async function keysFromSecret(secret: string): Promise<DeskKeys> {
  const raw = secret.trim();
  let privateKey = raw;
  if (raw.startsWith("{")) {
    const parsed = JSON.parse(raw) as { privateKey?: string; publicKey?: string };
    if (!parsed.privateKey) throw new Error("SLIPWAY_SIGNING_KEY JSON has no privateKey");
    privateKey = parsed.privateKey;
  }
  const extractable = await globalThis.crypto.subtle.importKey(
    "pkcs8",
    fromB64(privateKey),
    { name: "Ed25519" },
    true,
    ["sign"],
  );
  const jwk = await globalThis.crypto.subtle.exportKey("jwk", extractable);
  if (!jwk.x) throw new Error("SLIPWAY_SIGNING_KEY: cannot derive the public key");
  const publicKey = b64urlToB64(jwk.x);
  const keys = await importKeyPair({ publicKey, privateKey });
  return { keys, publicKey, origin: "env" };
}

let cached: Promise<DeskKeys> | null = null;

export function envKeys(env: Record<string, string | undefined> = process.env): Promise<DeskKeys> {
  cached ??= (async () => {
    const secret = env.SLIPWAY_SIGNING_KEY;
    if (secret) return keysFromSecret(secret);
    if (env.NODE_ENV === "production") throw new Error("SLIPWAY_SIGNING_KEY is required in production");
    const keys = await generateSigningKeys();
    return { keys, publicKey: await exportPublicKey(keys.publicKey), origin: "ephemeral" as const };
  })();
  cached.catch(() => {
    cached = null;
  });
  return cached;
}
