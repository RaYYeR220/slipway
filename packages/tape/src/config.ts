// Runtime configuration for the CLI jobs (env only; no secrets are ever read from the repo).
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultTokenProvider } from "./gcs.js";
import { PUBLIC_BUCKET, type TapeSource, tapeSource } from "./source.js";
import { FsObjectStore, GcsObjectStore, type ObjectStore } from "./store.js";

export const UNIVERSE = [
  "NVDA",
  "TSLA",
  "AAPL",
  "MSFT",
  "AMZN",
  "GOOGL",
  "META",
  "AMD",
  "MU",
  "INTC",
  "MSTR",
  "COIN",
  "CRCL",
  "HOOD",
  "PLTR",
  "SPY",
  "QQQ",
  "SOXL",
] as const;

export interface Config {
  source: TapeSource;
  work: string;
  bucket: string;
  symbols: string[];
  store(): Promise<ObjectStore>;
}

export function loadConfig(env = process.env): Config {
  const vmData = "/opt/slipway/data";
  const publicTape = `gs://${PUBLIC_BUCKET}/tape/raw`;
  const sourceSpec = env.TAPE_SOURCE ?? (existsSync(vmData) ? `${vmData}|${publicTape}` : publicTape);
  const work =
    env.SLIPWAY_WORK ??
    (existsSync("/opt/slipway") ? "/opt/slipway/work" : join(process.cwd(), ".slipway-work"));
  const bucket = env.SLIPWAY_BUCKET ?? PUBLIC_BUCKET;
  const target = env.SLIPWAY_STORE ?? `gs://${bucket}`;
  let store: ObjectStore | null = null;
  return {
    source: tapeSource(sourceSpec, join(work, "tape-cache")),
    work,
    bucket,
    symbols: env.SYMS ? env.SYMS.split(/[\s,]+/).filter(Boolean) : [...UNIVERSE],
    async store() {
      if (!store)
        store = target.startsWith("gs://")
          ? new GcsObjectStore(target.slice(5), await defaultTokenProvider(env))
          : new FsObjectStore(target);
      return store;
    },
  };
}

export async function readJsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}
