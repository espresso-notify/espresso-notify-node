#!/usr/bin/env node
// Fails when `npm pack` would put a file in the tarball outside dist/, README.md, CHANGELOG.md, LICENSE and package.json
// (server-libraries SRVL-09 AC4), or leaves out one the package needs. Run from sdk-server/node after `npm run build`.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ALLOWED_FILES = new Set(["README.md", "CHANGELOG.md", "LICENSE", "package.json"]);
const REQUIRED_FILES = [
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
  "package.json",
  "dist/index.mjs",
  "dist/index.cjs",
  "dist/index.d.mts",
  "dist/index.d.ts",
];

/** Paths (as `npm pack --json` lists them) that are not allowed in the tarball. */
export function unexpectedFiles(paths) {
  return paths.filter((p) => !(ALLOWED_FILES.has(p) || p.startsWith("dist/")));
}

/** Required paths the tarball does not hold. */
export function missingFiles(paths) {
  return REQUIRED_FILES.filter((p) => !paths.includes(p));
}

function main() {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8" });
  const paths = JSON.parse(out)[0].files.map((f) => f.path);
  const extra = unexpectedFiles(paths);
  const missing = missingFiles(paths);
  for (const p of paths) console.log(p);
  if (extra.length || missing.length) {
    if (extra.length) console.error(`not allowed in the tarball: ${extra.join(", ")}`);
    if (missing.length) console.error(`missing from the tarball: ${missing.join(", ")}`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
