// Ed25519 signing key of the evaluation scheduler. Lives only on the VM (work dir, mode 0600), never in the repo.
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { exportKeyPair, generateSigningKeys, importKeyPair } from "@slipway/core";

export async function loadOrCreateKeys(path: string): Promise<{ keys: CryptoKeyPair; pubkey: string }> {
  try {
    const k = JSON.parse(await readFile(path, "utf8")) as { publicKey: string; privateKey: string };
    return { keys: await importKeyPair(k), pubkey: k.publicKey };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const keys = await generateSigningKeys();
  const exported = await exportKeyPair(keys);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(exported), { mode: 0o600, flag: "wx" });
  await chmod(path, 0o600);
  return { keys, pubkey: exported.publicKey };
}
