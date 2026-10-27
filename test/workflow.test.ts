import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// SRVL-10 (T28, validation.md security L5): the job that installs the dependencies and runs the tests never holds the permission to
// sign. Only the stage job has `id-token: write`, and it runs nothing of the package. The workflow is read as text: this package has
// no dependency to read YAML with, and the file is written in one regular shape.

const text = readFileSync(join(new URL("..", import.meta.url).pathname, ".github", "workflows", "publish.yml"), "utf8");
const code = text
  .split("\n")
  .filter((line) => !/^\s*#/.test(line))
  .join("\n"); // the explanations in the header mention the words this test looks for

const start = code.indexOf("\njobs:\n");
const top = code.slice(0, start);

/** The text of each job: from its name at two spaces to the next job. */
function jobsOf(source: string): Record<string, string> {
  const body = source.slice(source.indexOf("\njobs:\n") + "\njobs:\n".length);
  const found: Record<string, string> = {};
  const names = [...body.matchAll(/^  ([a-z][a-z0-9_-]*):\s*$/gm)];
  names.forEach((match, i) => {
    found[match[1]!] = body.slice(match.index! + match[0].length, i + 1 < names.length ? names[i + 1]!.index : undefined);
  });
  return found;
}

const jobs = jobsOf(code);
/** Every command a job runs: the text of each `run:`, on its line or in its block. */
function runs(job: string): string {
  const out: string[] = [];
  const lines = job.split("\n");
  lines.forEach((line, i) => {
    const m = /^(\s+)(?:-\s+)?run:\s*(.*)$/.exec(line);
    if (!m) return;
    if (m[2] && m[2] !== "|") return void out.push(m[2]);
    const indent = m[1]!.length;
    for (let k = i + 1; k < lines.length && (lines[k]!.trim() === "" || lines[k]!.search(/\S/) > indent); k++) out.push(lines[k]!);
  });
  return out.join("\n");
}

describe("the publish workflow", () => {
  it("has the two jobs, verify and stage", () => {
    expect(Object.keys(jobs)).toEqual(["verify", "stage"]);
    expect(start).toBeGreaterThan(0);
  });

  it("is read only at the top, and only the stage job holds id-token: write", () => {
    expect(top).toMatch(/^permissions:\n {2}contents: read\n/m);
    expect(top).not.toContain("id-token");
    const holders = Object.entries(jobs).filter(([, job]) => /^\s+id-token:\s*write\b/m.test(job)).map(([name]) => name);
    expect(holders).toEqual(["stage"]);
    expect((code.match(/id-token:\s*write/g) ?? []).length).toBe(1);
  });

  it("gives verify read-only permissions, no environment and no secret", () => {
    const verify = jobs.verify!;
    expect(verify).toMatch(/^ {4}permissions:\n {6}contents: read\n/m);
    expect(verify).not.toMatch(/^\s+id-token:/m);
    expect(verify).not.toMatch(/^ {4}environment:/m);
    expect(verify).not.toContain("secrets.");
    expect(verify).not.toContain("NODE_AUTH_TOKEN");
    expect(verify).not.toContain("npm stage");
  });

  it("runs the install, the tests and the build in verify, after the checks of the tag, the version and the changelog", () => {
    const verify = jobs.verify!;
    const at = (needle: string) => verify.indexOf(needle);
    for (const needle of ["npm ci --ignore-scripts", "npm run typecheck", "npm test", "npm run build", "npm run check:pack"]) {
      expect(at(needle), needle).toBeGreaterThan(-1);
    }
    expect(at("Check the tag, the version and the changelog")).toBeGreaterThan(-1);
    expect(at("Check the tag, the version and the changelog")).toBeLessThan(at("npm ci --ignore-scripts"));
    expect(at("npm run build")).toBeLessThan(at("actions/upload-artifact"));
  });

  it("makes stage wait for verify, in the protected environment, and run nothing of the package", () => {
    const stage = jobs.stage!;
    expect(stage).toMatch(/^ {4}needs:\s*verify\s*$/m);
    expect(stage).toMatch(/^ {4}environment:\s*npm-publish\s*$/m);
    for (const forbidden of ["npm ci", "npm install", "npm test", "npm run build", "npm run typecheck", "npx ", "node scripts/"]) {
      expect(runs(stage), forbidden).not.toContain(forbidden);
    }
    expect(stage).not.toMatch(/node-version-file|cache:/);
  });

  it("stages with provenance exactly once, and only in stage", () => {
    expect((code.match(/^\s*npm stage publish\b/gm) ?? []).length).toBe(1);
    expect(jobs.stage).toContain("npm stage publish");
    expect(jobs.stage).toContain("--provenance");
    expect(jobs.stage).toContain("--ignore-scripts");
  });

  it("publishes directly in one step only: the first publish, by hand, with the token, with provenance, after the existence check", () => {
    expect((code.match(/^\s*npm publish\b/gm) ?? []).length).toBe(1);
    expect(jobs.verify).not.toMatch(/^\s*npm publish\b/m);
    const first = /- name: First publish with provenance\n([\s\S]*?)(?=\n {6}- name:|\n {6}# |$)/.exec(jobs.stage!)?.[1] ?? "";
    expect(first).toContain("github.event_name == 'workflow_dispatch' && inputs.first_publish");
    expect(first).toContain("secrets.NPM_TOKEN");
    expect(first).toContain("--provenance");
    expect(first).toMatch(/^\s*npm publish\b/m);
    const at = (needle: string) => jobs.stage!.indexOf(needle);
    expect(at("the package must not exist on npm yet")).toBeGreaterThan(-1);
    expect(at("the package must not exist on npm yet")).toBeLessThan(at("First publish with provenance"));
    expect(jobs.stage).toMatch(/- name: Stage with provenance\n\s+if: github\.event_name != 'workflow_dispatch' \|\| !inputs\.first_publish/);
  });

  it("hands the tested build to stage under one name", () => {
    const up = /actions\/upload-artifact@[0-9a-f]{40}[\s\S]*?name:\s*(\S+)/.exec(jobs.verify!);
    const down = /actions\/download-artifact@[0-9a-f]{40}[\s\S]*?name:\s*(\S+)/.exec(jobs.stage!);
    expect(up?.[1]).toBeTruthy();
    expect(down?.[1]).toBe(up?.[1]);
    expect(jobs.verify).toMatch(/if-no-files-found:\s*error/);
  });

  it("pins every action by commit SHA, with the version in a comment", () => {
    const uses = [...text.matchAll(/^\s*(?:-\s+)?uses:\s+(\S+)\s*(#.*)?$/gm)];
    expect(uses.length).toBeGreaterThanOrEqual(5);
    for (const [, ref, comment] of uses) {
      expect(ref, ref).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
      expect(comment, ref).toMatch(/^#\s*v\d+(\.\d+)*/);
    }
  });
});
