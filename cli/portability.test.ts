import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installBundle, minimalRepo, rvw, type InstalledCli, type RvwResult } from "./fixtures";

// The load-bearing claim: `rvw` is the *agent's* tool, runnable in any repo — not a
// Reviewer-repo dev script. Asserting that requires actually leaving the repo, so this suite
// drives the distributed bundle from a throwaway install directory and a throwaway git repo,
// neither of which has a `node_modules` anywhere above it. Nothing here reaches back into the
// checkout: if the bundle silently resolved `@pierre/diffs` from Reviewer's own
// `node_modules`, the copy would break and these tests would fail — which is the point.
//
// It also pins the shebang bug that made this necessary: `bun build` stamps a
// `#!/usr/bin/env bun` entrypoint as bun-only, and the emitted bundle then throws inside
// Stricli's router under Node. `fixtures.rvw` runs the bundle under `node` (not bun) even
// though the repo's toolchain is bun, because that is what catches a regression.

let cli: InstalledCli;
const roots: string[] = [];

/** A fresh foreign repo per test, registered for teardown — each test mutates its own repo
 * (a decoy skills dir, an emitted artifact), so they must not share one. */
function repo(): ReturnType<typeof minimalRepo> {
  const created = minimalRepo();
  roots.push(created.path);
  return created;
}

/** stdout and stderr together: a few assertions here only care that a message surfaced at
 * all, and which stream carried it is the exit-gate suite's concern, not this one's. */
function output(result: RvwResult): string {
  return `${result.stdout}${result.stderr}`;
}

beforeAll(() => {
  cli = installBundle();
  roots.push(cli.root);
  expect(existsSync(cli.bundle)).toBe(true);
  // The install root and every temp dir above it must be dependency-free, or "runs without the
  // target repo's node_modules" would be proven against a directory that has some.
  expect(existsSync(join(dirname(dirname(cli.bundle)), "node_modules"))).toBe(false);
}, 60_000);

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("the distributed bundle declares what it is", () => {
  it("ships a `type: module` beside the bundle rather than relying on Node to guess", () => {
    // The bundle is ESM in a `.js` file. Without this declaration it executes only on a Node
    // new enough to detect module syntax (>=20.19 / >=22.7); on anything older — including a
    // Node that Electron might embed — it dies on the first `import`, long before any
    // question of resolving @pierre/diffs arises.
    const manifest: unknown = JSON.parse(
      readFileSync(join(dirname(cli.bundle), "package.json"), "utf8"),
    );
    expect(manifest).toEqual({ type: "module" });
  });

  it("carries a node shebang, not bun's", () => {
    const firstLine = readFileSync(cli.bundle, "utf8").split("\n", 1)[0];
    expect(firstLine).toBe("#!/usr/bin/env node");
  });
});

describe("rvw runs from a repo that is not the Reviewer checkout", () => {
  it("resolves the bundled @pierre/diffs to report a real changed-line universe", () => {
    const foreign = repo();
    expect(existsSync(join(foreign.path, "node_modules"))).toBe(false);

    const result = rvw(cli, foreign, ["diff", "--base", foreign.base, "--json"]);
    expect(result.status, output(result)).toBe(0);
    const files = JSON.parse(result.stdout) as {
      file: string;
      coverable: boolean;
      spans?: { side: string; startLine: number; endLine: number }[];
    }[];
    expect(files.map((file) => file.file)).toEqual(["a.txt"]);
    expect(files[0]?.spans).toEqual([
      { side: "deletions", startLine: 2, endLine: 2 },
      { side: "additions", startLine: 2, endLine: 2 },
      { side: "additions", startLine: 4, endLine: 4 },
    ]);
  });

  it("emits an artifact, then checks it — the authoring loop, entirely outside the checkout", () => {
    const foreign = repo();
    const draft = JSON.stringify({
      comments: [{ file: "a.txt", side: "additions", startLine: 2, endLine: 2, body: "why" }],
      layers: [
        {
          label: "All",
          summary: "the change",
          ranges: [
            { file: "a.txt", side: "additions", startLine: 2, endLine: 4 },
            { file: "a.txt", side: "deletions", startLine: 2, endLine: 2 },
          ],
        },
      ],
    });
    const out = join(foreign.path, "change.reviewer.json");

    // Draft on stdin, range defaulted to the repo the bundle is standing in: the invocation an
    // agent actually makes, proven across the bundle boundary.
    const emitted = rvw(
      cli,
      foreign,
      ["emit", "--base", foreign.base, "--no-open", "--out", out],
      draft,
    );
    expect(emitted.status, output(emitted)).toBe(0);

    const checked = rvw(cli, foreign, ["check", out, "--require-complete"]);
    expect(checked.status, output(checked)).toBe(0);
    expect(checked.stdout).toContain("ready to hand over");
  });

  it("prints the schema and the skills it shipped with, not the foreign repo's", () => {
    const foreign = repo();
    // A decoy: the repo being reviewed has its own skills/, which must not be read.
    mkdirSync(join(foreign.path, "skills", "decoy"), { recursive: true });
    writeFileSync(
      join(foreign.path, "skills", "decoy", "SKILL.md"),
      "---\nname: decoy\ndescription: must never be listed\n---\n",
    );

    const skills = rvw(cli, foreign, ["skills", "--json"]);
    expect(skills.status, output(skills)).toBe(0);
    const listed = JSON.parse(skills.stdout) as { name: string }[];
    expect(listed.map((skill) => skill.name)).toContain("present-review");
    expect(listed.map((skill) => skill.name)).not.toContain("decoy");

    const schema = rvw(cli, foreign, ["schema", "--json"]);
    expect(schema.status, output(schema)).toBe(0);
    expect(JSON.parse(schema.stdout)).toMatchObject({ title: ".reviewer.json" });
  });

  it("keeps the 0/1/2 exit contract across the bundle boundary", () => {
    const foreign = repo();
    expect(rvw(cli, foreign, ["frobnicate"]).status).toBe(2);
    expect(rvw(cli, foreign, ["check", join(foreign.path, "missing.reviewer.json")]).status).toBe(
      2,
    );
    // `open` is wired into the bundle: its pre-launch path check refuses a non-review with
    // exit 2 without spawning a launcher, so the verb is provably reachable from a foreign
    // repo. The actual launch is not driven here — it would depend on Reviewer being installed.
    expect(rvw(cli, foreign, ["open", join(foreign.path, "not-a-review.txt")]).status).toBe(2);

    const misAnchored = join(foreign.path, "bad.reviewer.json");
    writeFileSync(misAnchored, "}{ not json");
    expect(rvw(cli, foreign, ["check", misAnchored]).status).toBe(1);
  });
});
