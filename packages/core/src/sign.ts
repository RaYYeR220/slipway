import { verdictOf } from "./gate.js";
import type { GateResult, Plan, SignedPlan } from "./types.js";

const SIG_DOMAIN = "slipway-plan-v1";
const MAX_CLOCK_SKEW_MS = 5_000;
const ED25519 = { name: "Ed25519" } as const;

// Sorted keys, no whitespace, undefined properties dropped; anything JSON would silently alter is rejected.
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "number":
      if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: non-finite number ${value}`);
      return JSON.stringify(value);
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "bigint":
      throw new TypeError("canonicalJson: bigint is not representable");
    case "undefined":
      throw new TypeError("canonicalJson: undefined outside an object property");
    case "object": {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null)
        throw new TypeError("canonicalJson: only plain objects are allowed");
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
    }
    default:
      throw new TypeError(`canonicalJson: ${typeof value} is not representable`);
  }
}

const utf8 = (s: string) => new TextEncoder().encode(s);
const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export async function sha256Hex(text: string): Promise<string> {
  return toHex(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", utf8(text))));
}

export const hashPlan = (plan: Plan, gate: GateResult): Promise<string> =>
  sha256Hex(canonicalJson({ plan, gate }));

// The signature binds the content hash to the issuance time so a valid signature cannot be re-dated.
const signedMessage = (hash: string, issuedAt: number) => utf8(`${SIG_DOMAIN}:${hash}:${issuedAt}`);

export async function generateSigningKeys(): Promise<CryptoKeyPair> {
  return (await globalThis.crypto.subtle.generateKey(ED25519, true, ["sign", "verify"])) as CryptoKeyPair;
}

export async function exportPublicKey(key: CryptoKey): Promise<string> {
  return toBase64(new Uint8Array(await globalThis.crypto.subtle.exportKey("raw", key)));
}

export async function exportKeyPair(keys: CryptoKeyPair): Promise<{ publicKey: string; privateKey: string }> {
  const pkcs8 = new Uint8Array(await globalThis.crypto.subtle.exportKey("pkcs8", keys.privateKey));
  return { publicKey: await exportPublicKey(keys.publicKey), privateKey: toBase64(pkcs8) };
}

export async function importPublicKey(b64: string): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey("raw", fromBase64(b64), ED25519, true, ["verify"]);
}

export async function importKeyPair(k: { publicKey: string; privateKey: string }): Promise<CryptoKeyPair> {
  const privateKey = await globalThis.crypto.subtle.importKey(
    "pkcs8",
    fromBase64(k.privateKey),
    ED25519,
    true,
    ["sign"],
  );
  return { publicKey: await importPublicKey(k.publicKey), privateKey };
}

export async function signPlan(
  plan: Plan,
  gate: GateResult,
  keys: CryptoKeyPair,
  issuedAt: number,
): Promise<SignedPlan> {
  const hash = await hashPlan(plan, gate);
  const sig = new Uint8Array(
    await globalThis.crypto.subtle.sign(ED25519, keys.privateKey, signedMessage(hash, issuedAt)),
  );
  return { plan, gate, hash, sig: toBase64(sig), pubkey: await exportPublicKey(keys.publicKey), issuedAt };
}

export async function verifySignedPlan(
  signed: SignedPlan,
  trustedPubkey: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (signed.pubkey !== trustedPubkey)
    return { ok: false, reason: "signed with a key other than the trusted key" };
  let hash: string;
  try {
    hash = await hashPlan(signed.plan, signed.gate);
  } catch (e) {
    return { ok: false, reason: `plan is not canonicalisable: ${(e as Error).message}` };
  }
  if (hash !== signed.hash)
    return { ok: false, reason: "content hash mismatch: plan or gate changed after signing" };
  let valid = false;
  try {
    const key = await importPublicKey(trustedPubkey);
    valid = await globalThis.crypto.subtle.verify(
      ED25519,
      key,
      fromBase64(signed.sig),
      signedMessage(hash, signed.issuedAt),
    );
  } catch {
    valid = false;
  }
  return valid ? { ok: true } : { ok: false, reason: "invalid signature" };
}

export async function assertTicketable(
  signed: SignedPlan,
  trustedPubkey: string,
  now: number,
  maxAgeMs = 60_000,
): Promise<void> {
  const v = await verifySignedPlan(signed, trustedPubkey);
  if (!v.ok) throw new Error(`not ticketable: ${v.reason}`);
  if (verdictOf(signed.gate.checks) !== signed.gate.verdict) {
    throw new Error("not ticketable: signed verdict contradicts its own checks");
  }
  if (signed.gate.verdict !== "allow")
    throw new Error(`not ticketable: gate verdict is ${signed.gate.verdict}`);
  const age = now - signed.issuedAt;
  if (age < -MAX_CLOCK_SKEW_MS) throw new Error(`not ticketable: issued ${-age} ms in the future`);
  if (age > maxAgeMs) throw new Error(`not ticketable: signature is ${age} ms old (max ${maxAgeMs})`);
}
