import { describe, expect, it } from "vitest";
// @ts-expect-error the script is plain JavaScript run by CI as well
import { missingFiles, unexpectedFiles } from "../scripts/check-pack.mjs";

const good = [
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "package.json",
  "dist/index.mjs",
  "dist/index.cjs",
  "dist/index.d.mts",
  "dist/index.d.ts",
];

// SRVL-09 AC4: a tarball with a file outside dist/, README.md, CHANGELOG.md, LICENSE and package.json fails.
describe("pack allow-list", () => {
  it("accepts exactly the allowed files", () => {
    expect(unexpectedFiles(good)).toEqual([]);
    expect(missingFiles(good)).toEqual([]);
  });

  it("names a source file, a test, an env file and a generator config that would leak into the tarball", () => {
    const leaked = ["src/client.ts", "test/contract.test.ts", ".env", "openapi-generator.yaml", "NOTICE"];
    expect(unexpectedFiles([...good, ...leaked])).toEqual(leaked);
  });

  it("names a required file that is missing", () => {
    expect(missingFiles(good.filter((p) => p !== "dist/index.cjs" && p !== "LICENSE"))).toEqual(["LICENSE", "dist/index.cjs"]);
  });
});
