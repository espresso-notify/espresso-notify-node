import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error the script is plain JavaScript run by CI as well
import { exportApi, serializeLock } from "../scripts/export-api.mjs";

// sdk-parity PAR-48: the public API lock lists the exports of src/index.ts and is regenerated in memory.
const root = new URL("..", import.meta.url).pathname;
const committed = readFileSync(join(root, "api", "exports.json"), "utf8");
const lock = JSON.parse(committed) as { types: Record<string, string[]>; functions: string[] };

describe("api/exports.json", () => {
  it("is fresh against src/index.ts", () => {
    expect(serializeLock(exportApi(root))).toBe(committed);
  });

  it("lists the identity token signer, the signature verifier and the client", () => {
    expect(lock.functions).toEqual(expect.arrayContaining(["signIdentityToken", "verifySignature", "VERSION"]));
    expect(lock.types.EspressoNotify).toEqual(expect.arrayContaining(["notifications", "users", "tokens", "conversions"]));
    expect(lock.types).toHaveProperty("EspressoNotifySignatureError");
  });

  it("leaves the internal idempotency helpers out", () => {
    expect(lock.functions).not.toContain("withIdempotencyKey");
    expect(lock.functions).not.toContain("withIdempotencyKeys");
  });

  it("is kept out of the published package", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { files: string[] };
    expect(pkg.files).not.toContain("api");
  });
});

describe("the exporter on a fixture", () => {
  let dir: string;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  const INDEX =
    'export { Client, type Opts } from "./client";\nexport type { Hidden } from "./client";\nexport function sign(): void {}\n' +
    "/** @internal */\nexport function internalFn(): void {}\n";
  const CLIENT =
    "export class Client { users = 1; private secret = 2; _skip = 3; run() {} }\nexport interface Opts { a: string }\nexport interface Hidden { b: string }\n";

  function fixture(client: string): string {
    dir = mkdtempSync(join(tmpdir(), "node-api-lock-"));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "index.ts"), INDEX);
    writeFileSync(join(dir, "src", "client.ts"), client);
    return dir;
  }

  it("lists public class members and functions, and drops re-exported types", () => {
    expect(exportApi(fixture(CLIENT))).toEqual({ types: { Client: ["run", "users"] }, functions: ["sign"] });
  });

  it("changes the lock when a public member is added", () => {
    const before = serializeLock(exportApi(fixture(CLIENT)));
    const after = serializeLock(exportApi(fixture(CLIENT.replace("run() {}", "run() {} added() {}"))));
    expect(after).not.toBe(before);
  });
});
