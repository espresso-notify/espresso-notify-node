#!/usr/bin/env node
// Writes api/exports.json: the public surface of src/index.ts, read with the TypeScript compiler (sdk-parity PAR-48).
// The shape is the one of the React Native and web locks:
//   { "types": { "EspressoNotify": ["addToken", ...], "EspressoNotifyApiError": [...] }, "functions": ["signIdentityToken", ...] }
// - `types` holds the classes (with their public members: no private or protected member, no name starting with `_`,
//   nothing marked @internal) and the interfaces, type aliases and enums the entry declares (empty list).
// - `functions` holds the exported functions and constants.
// - A type the entry only re-exports from another module (`export type { X } from`, `export { type X }`) is dropped.
// The idempotency helpers (`withIdempotencyKey`) are internal: the client attaches the keys itself, so they are not in
// the lock. `test/api-lock.test.ts` regenerates the lock in memory and fails when it is stale.
// Usage: node scripts/export-api.mjs [--check]   (run from sdk-server/node)
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOCK = "api/exports.json";
const { SymbolFlags } = ts;

function isInternal(declarations) {
  return (declarations ?? []).some((node) => ts.getJSDocTags(node).some((tag) => tag.tagName.text === "internal"));
}

function isHidden(member, sourceFile) {
  const name = member.name?.getText(sourceFile) ?? "";
  if (name.startsWith("_")) return true;
  if (ts.getCombinedModifierFlags(member) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) return true;
  return ts.getJSDocTags(member).some((tag) => tag.tagName.text === "internal");
}

function classMembers(declarations) {
  const names = new Set();
  for (const node of declarations ?? []) {
    if (!ts.isClassDeclaration(node)) continue;
    const sourceFile = node.getSourceFile();
    for (const member of node.members) {
      if (member.name === undefined || isHidden(member, sourceFile)) continue;
      names.add(member.name.getText(sourceFile));
    }
  }
  return [...names].sort();
}

function isTypeOnlyExport(symbol) {
  return (symbol.declarations ?? []).some(
    (node) => ts.isExportSpecifier(node) && (node.isTypeOnly || node.parent.parent.isTypeOnly),
  );
}

/** The public surface of `src/index.ts` under `root`. */
export function exportApi(root = ROOT) {
  const src = join(root, "src");
  const rootNames = readdirSync(src, { recursive: true })
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(src, name));
  const program = ts.createProgram({
    rootNames,
    options: { noResolve: true, noLib: true, types: [], skipLibCheck: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(join(src, "index.ts"));
  if (!sourceFile) throw new Error("src/index.ts was not found");
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  const types = {};
  const functions = new Set();
  for (const symbol of moduleSymbol ? checker.getExportsOfModule(moduleSymbol) : []) {
    const name = symbol.getName();
    if (name.startsWith("_") || name === "default") continue;
    const reexport = (symbol.flags & SymbolFlags.Alias) !== 0;
    if (reexport && isTypeOnlyExport(symbol)) continue;
    const target = reexport ? checker.getAliasedSymbol(symbol) : symbol;
    if (isInternal(target.declarations)) continue;
    const flags = target.flags;
    if (flags & SymbolFlags.Class) types[name] = classMembers(target.declarations);
    else if (flags & (SymbolFlags.Function | SymbolFlags.Variable)) functions.add(name);
    else if (flags & (SymbolFlags.Enum | SymbolFlags.Interface | SymbolFlags.TypeAlias)) {
      if (!reexport) types[name] = [];
    }
  }
  const sorted = Object.fromEntries(Object.entries(types).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return { types: sorted, functions: [...functions].sort() };
}

/** The text of the lock file. */
export function serializeLock(lock) {
  return `${JSON.stringify(lock, null, 2)}\n`;
}

function main() {
  const fresh = serializeLock(exportApi());
  const file = join(ROOT, LOCK);
  if (process.argv.includes("--check")) {
    let current = null;
    try {
      current = readFileSync(file, "utf8");
    } catch {}
    if (current !== fresh) {
      console.error(`${LOCK} is stale; run: node scripts/export-api.mjs`);
      process.exit(1);
    }
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, fresh);
  console.log(`wrote ${LOCK}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
