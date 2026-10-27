import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  target: "node22",
  platform: "node",
  clean: true,
  splitting: false,
  sourcemap: false,
  // The version in the User-Agent is the one in package.json, never a second copy.
  define: { __LIB_VERSION__: JSON.stringify(pkg.version) },
  outExtension: ({ format }) => ({ js: format === "esm" ? ".mjs" : ".cjs" }),
});
