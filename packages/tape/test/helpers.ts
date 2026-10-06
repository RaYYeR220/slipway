import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

export const FIX = fileURLToPath(new URL("./fixtures/", import.meta.url));
export const fix = (...p: string[]) => join(FIX, ...p);
export const readJson = <T>(...p: string[]): T => {
  const buf = readFileSync(fix(...p));
  return JSON.parse((p.at(-1)?.endsWith(".gz") ? gunzipSync(buf) : buf).toString()) as T;
};
export const tempDir = (prefix = "slipway-tape-") => mkdtempSync(join(tmpdir(), prefix));
