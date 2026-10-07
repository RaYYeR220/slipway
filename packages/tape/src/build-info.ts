// Which code produced an artifact: injected by scripts/bundle.mjs into the VM bundle (git commit of the repo and of
// packages/core at build time); null when running from source.
declare const SLIPWAY_BUILD: BuildInfo | undefined;

export interface BuildInfo {
  commit: string;
  coreCommit: string;
  dirty: boolean;
  builtAt: string;
}

export const BUILD: BuildInfo | null = typeof SLIPWAY_BUILD === "undefined" ? null : SLIPWAY_BUILD;
