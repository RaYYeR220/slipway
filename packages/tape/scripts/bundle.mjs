// Single-file bundles of the CLIs for the VM (node24, ESM): `node cli.mjs <command>`, `node verify-cli.mjs`.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { build } from "esbuild";

// @slipway/bitget reads the SDK version from the SDK's package.json at runtime; inline it for a self-contained file.
const sdkVersion = createRequire(new URL("../../bitget/package.json", import.meta.url))(
  "@bitget-ai/bitget-agent-sdk/package.json",
).version;
const inlineSdkVersion = {
  name: "inline-sdk-version",
  setup(b) {
    b.onLoad({ filter: /bitget[\\/](dist|src)[\\/]ticket\.(js|ts)$/ }, async (args) => ({
      contents: (await readFile(args.path, "utf8")).replace(
        /createRequire\(import\.meta\.url\)\("@bitget-ai\/bitget-agent-sdk\/package\.json"\)/,
        JSON.stringify({ version: sdkVersion }),
      ),
      loader: args.path.endsWith(".ts") ? "ts" : "js",
    }));
  },
};

await build({
  entryPoints: ["src/cli.ts", "src/verify-cli.ts"],
  outdir: "bundle",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  legalComments: "none",
  plugins: [inlineSdkVersion],
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: "warning",
});
