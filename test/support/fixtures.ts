import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The fixtures are written by the backend (backend/internal/contract/serverlib). In the monorepo they sit next to this
// package, in sdk-server/fixtures; in the public mirror they sit at its root, in fixtures/.
const here = new URL("../..", import.meta.url).pathname;
const dir = [join(here, "fixtures"), join(here, "..", "fixtures")].find((candidate) => existsSync(join(candidate, "sendTransactional.json")));
if (!dir) throw new Error("the contract fixtures are not next to this package");

export interface Fixture {
  operationId: string;
  method: string;
  path: string;
  pathTemplate: string;
  pathParams?: Record<string, string>;
  key: "secret" | "public";
  request: { headers?: Record<string, string>; body?: any };
  response: { status: number; headers?: Record<string, string>; body?: any };
}

export function fixture(operationId: string): Fixture {
  return JSON.parse(readFileSync(join(dir!, `${operationId}.json`), "utf8")) as Fixture;
}

export function allFixtures(): Fixture[] {
  return readdirSync(dir!)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => fixture(name.slice(0, -".json".length)));
}

export interface SignatureCase {
  name: string;
  description: string;
  scheme: "hmac_sha256" | "ed25519";
  input: {
    body: string;
    headers: Record<string, string>;
    secrets?: string[];
    publicKeys?: string[];
    toleranceSeconds?: number;
    now: number;
  };
  expected: { valid: boolean; payload?: unknown; error?: string; messageContains?: string[] };
}

export function signatureCases(): SignatureCase[] {
  const folder = join(dir!, "signatures");
  return readdirSync(folder)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(folder, name), "utf8")) as SignatureCase);
}

/** An answer of the API to a refused call, from sdk-server/fixtures/errors (error_<status>_<reason>). */
export function errorFixture(name: string): Fixture {
  return JSON.parse(readFileSync(join(dir!, "errors", `${name}.json`), "utf8")) as Fixture;
}

export function allErrorFixtures(): Fixture[] {
  const folder = join(dir!, "errors");
  return readdirSync(folder)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => errorFixture(name.slice(0, -".json".length)));
}

/** The operationIds of sdk-server/operations.txt, the include list every server library is generated from. */
export function includeList(): string[] {
  const file = [join(here, "operations.txt"), join(here, "..", "operations.txt")].find((candidate) => existsSync(candidate));
  if (!file) throw new Error("operations.txt is not next to this package");
  return readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.split("#")[0]!.trim())
    .filter(Boolean);
}
