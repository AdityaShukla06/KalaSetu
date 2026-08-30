import { build } from "esbuild";
import { mkdirSync } from "node:fs";

mkdirSync("api", { recursive: true });

await build({
  entryPoints: ["server/vercel.ts"],
  outfile: "api/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  packages: "external",
  logLevel: "info",
});
