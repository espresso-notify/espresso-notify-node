import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src";

const root = new URL("..", import.meta.url).pathname;
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, unknown> & {
  exports: Record<string, Record<string, Record<string, string>>>;
};

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : path.endsWith(".ts") ? [path] : [];
  });
}

// SRVL-09 AC3: ESM and CommonJS entry points and type declarations, engines.node >=22, zero runtime dependencies.
describe("package shape", () => {
  it("is @espresso-notify/node", () => {
    expect(pkg.name).toBe("@espresso-notify/node");
  });

  it("declares Node 22 or newer", () => {
    expect((pkg.engines as { node: string }).node).toBe(">=22");
  });

  it("has no runtime dependency of any kind", () => {
    expect(pkg.dependencies).toEqual({});
    expect(pkg.peerDependencies).toBeUndefined();
    expect(pkg.optionalDependencies).toBeUndefined();
  });

  it("maps import and require to their own build and their own type declarations", () => {
    expect(pkg.exports["."]).toEqual({
      import: { types: "./dist/index.d.mts", default: "./dist/index.mjs" },
      require: { types: "./dist/index.d.ts", default: "./dist/index.cjs" },
    });
  });

  it("publishes dist and the changelog; npm adds README, LICENSE and package.json itself", () => {
    expect(pkg.files).toEqual(["dist", "CHANGELOG.md"]);
  });

  it("imports nothing at run time but Node's own modules and its own files", () => {
    const bare = /(?:from|import)\s*\(?\s*["']([^"'./][^"']*)["']/g;
    const found = new Set<string>();
    for (const file of sources(join(root, "src"))) {
      for (const match of readFileSync(file, "utf8").matchAll(bare)) found.add(match[1]!);
    }
    expect([...found].filter((name) => !name.startsWith("node:"))).toEqual([]);
  });

  it("reports the version of package.json", () => {
    expect(VERSION).toBe(pkg.version);
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
