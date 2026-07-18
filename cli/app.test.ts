import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { Application, StricliProcess } from "@stricli/core";
import { buildCommand, buildRouteMap, run } from "@stricli/core";
import { describe, expect, it } from "vitest";
import type { ReviewArtifact } from "../src/shared/review";
import { app, buildRvwApplication } from "./app";
import { normalizeExitCode, type LocalContext } from "./context";

// The `rvw` surface driven the way the shipped entrypoint drives it — through Stricli's
// `run` against the real application — but bound to capturing streams so the whole
// exit-code contract (0 ready / 1 problems / 2 cannot-run) and both output channels are
// asserted in-process, no spawn. Routing, `--help`, `--json`, and every one of the eight
// verbs' behavior resolve here; `index.test.ts` proves the same codes on a real process
// and `portability.test.ts` proves the bundle carries them into a foreign repo.

const PATCH = [
  "diff --git a/src/foo.ts b/src/foo.ts",
  "index 1111111..2222222 100644",
  "--- a/src/foo.ts",
  "+++ b/src/foo.ts",
  "@@ -10,3 +10,5 @@",
  " ctx10",
  "-old11",
  "+new11",
  "+new12",
  "+new13",
  " ctx14",
  "diff --git a/src/bar.ts b/src/bar.ts",
  "index 3333333..4444444 100644",
  "--- a/src/bar.ts",
  "+++ b/src/bar.ts",
  "@@ -1,2 +1,3 @@",
  " keep1",
  "+added2",
  " keep3",
  "",
].join("\n");

const VALID: ReviewArtifact = {
  version: 1,
  source: { kind: "local", repo: { path: "/repo", name: "repo" }, base: "main", head: "feature" },
  patch: PATCH,
  comments: [{ file: "src/foo.ts", side: "additions", startLine: 11, endLine: 13, body: "note" }],
  layers: [
    {
      id: "leaf",
      label: "Leaf",
      summary: "child",
      kind: "feature",
      description: "Adds [bar](src/bar.ts).",
      ranges: [{ file: "src/bar.ts", side: "additions", startLine: 2, endLine: 2 }],
    },
  ],
};

// The same artifact with the comment dragged off every hunk — the mis-anchor the
// validator must catch with its exact locator.
const MIS_ANCHORED: ReviewArtifact = {
  ...VALID,
  comments: [
    { file: "src/foo.ts", side: "additions", startLine: 50, endLine: 50, body: "drifted" },
  ],
};

function capture(): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  return { stream, text: () => chunks.join("") };
}

type CliResult = { code: number; stdout: string; stderr: string };

async function runCli(
  args: readonly string[],
  application: Application<LocalContext> = app,
): Promise<CliResult> {
  const stdout = capture();
  const stderr = capture();
  const process: StricliProcess = { stdout: stdout.stream, stderr: stderr.stream, exitCode: null };
  await run(application, args, { process });
  return {
    code: normalizeExitCode(process.exitCode),
    stdout: stdout.text(),
    stderr: stderr.text(),
  };
}

/** Write an artifact (object or raw string) to a temp file and return its path, so
 * validate reads real untrusted bytes exactly as it does in production. */
function artifactFile(artifact: ReviewArtifact | string): string {
  const dir = mkdtempSync(join(tmpdir(), "reviewer-cli-"));
  const file = join(dir, "artifact.reviewer.json");
  writeFileSync(file, typeof artifact === "string" ? artifact : JSON.stringify(artifact));
  return file;
}

describe("rvw dispatch surface", () => {
  it("routes a known verb and recognizes --help and --json uniformly", async () => {
    const help = await runCli(["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("rvw");
    // --json is accepted on validate without being mistaken for the positional artifact.
    const json = await runCli(["validate", artifactFile(VALID), "--json"]);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual({ ok: true });
  });

  it("exits 2 on an unknown verb rather than routing it", async () => {
    const result = await runCli(["frobnicate"]);
    expect(result.code).toBe(2);
  });

  it("exits 2 when a required positional argument is missing", async () => {
    const result = await runCli(["validate"]);
    expect(result.code).toBe(2);
  });

  it("routes all eight review verbs — no verb is left an unimplemented seam", async () => {
    const help = await runCli(["--help"]);
    const verbs = ["validate", "coverage", "anchors", "emit", "check", "skills", "schema", "open"];
    for (const verb of verbs) {
      expect(help.stdout).toContain(`rvw ${verb}`);
    }
    expect(help.stdout).not.toContain("not yet implemented");
  });

  it("maps a command body that throws to exit 2 (cannot-run), not Stricli's positive throw code", async () => {
    // Stricli reports an uncaught command throw as CommandRunError = 1; without the app's
    // determineExitCode that would be misread as our "ran, found problems" (1). This proves
    // the seam every later verb's git/fs body relies on: an unexpected throw is shell-cannot-run.
    const throwing = buildCommand<Record<string, never>, [], LocalContext>({
      docs: { brief: "throws on run" },
      parameters: { flags: {} },
      func(this: LocalContext): void {
        throw new Error("boom");
      },
    });
    const throwingApp = buildRvwApplication(
      buildRouteMap({ routes: { boom: throwing }, docs: { brief: "throwing test app" } }),
    );
    const result = await runCli(["boom"], throwingApp);
    expect(result.code).toBe(2);
  });
});

describe("rvw validate", () => {
  it("exits 0 and reports valid on an artifact whose anchors all place", async () => {
    const result = await runCli(["validate", artifactFile(VALID)]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("valid — every anchor places");
  });

  it("exits 1 with the exact locator on a mis-anchored artifact", async () => {
    const result = await runCli(["validate", artifactFile(MIS_ANCHORED)]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("does not place");
    expect(result.stderr).toContain("src/foo.ts additions 50-50");
  });

  it("exits 1 (ran, found problems) on garbage bytes without throwing", async () => {
    const result = await runCli(["validate", artifactFile("}{ not json")]);
    expect(result.code).toBe(1);
  });

  it("emits the structured ValidationReport as JSON on --json, exit 1 when not ready", async () => {
    const result = await runCli(["validate", artifactFile(MIS_ANCHORED), "--json"]);
    expect(result.code).toBe(1);
    const report: unknown = JSON.parse(result.stdout);
    expect(report).toMatchObject({ ok: false });
  });

  it("exits 2 (shell could not run) when the artifact file cannot be read", async () => {
    const missing = join(tmpdir(), "reviewer-cli-does-not-exist.reviewer.json");
    const result = await runCli(["validate", missing]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("cannot read");
  });
});

// The same PATCH universe: src/foo.ts additions {11,12,13} + deletion {11}, src/bar.ts
// addition {2} — five coverable changed lines. FULLY_COVERED spans every one; GAP leaves
// all of foo in no layer.
const FULLY_COVERED: ReviewArtifact = {
  ...VALID,
  layers: [
    {
      id: "all",
      label: "All",
      summary: "covers everything",
      kind: "feature",
      ranges: [
        { file: "src/foo.ts", side: "additions", startLine: 11, endLine: 13 },
        { file: "src/foo.ts", side: "deletions", startLine: 11, endLine: 11 },
        { file: "src/bar.ts", side: "additions", startLine: 2, endLine: 2 },
      ],
    },
  ],
};

// VALID's lone layer covers only src/bar.ts addition 2, so all of src/foo.ts is a gap.
const GAP: ReviewArtifact = VALID;

describe("rvw coverage", () => {
  it("exits 0 with a 100% headline when every changed line is in a layer, and stays 0 under --require-complete", async () => {
    const covered = await runCli(["coverage", artifactFile(FULLY_COVERED)]);
    expect(covered.code).toBe(0);
    expect(covered.stdout).toContain("coverage 100% (5/5 changed lines)");

    const gated = await runCli(["coverage", artifactFile(FULLY_COVERED), "--require-complete"]);
    expect(gated.code).toBe(0);
  });

  it("reports a gap on stdout but exits 0 by default (advisory), listing the uncovered spans", async () => {
    const result = await runCli(["coverage", artifactFile(GAP)]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("src/foo.ts additions 11-13");
    expect(result.stdout).toContain("src/foo.ts deletions 11-11");
  });

  it("exits 1 under --require-complete when a coverable gap remains", async () => {
    const result = await runCli(["coverage", artifactFile(GAP), "--require-complete"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("uncovered      src/foo.ts");
  });

  it("emits the structured CoverageReport as JSON on --json", async () => {
    const result = await runCli(["coverage", artifactFile(GAP), "--json"]);
    expect(result.code).toBe(0);
    const report: unknown = JSON.parse(result.stdout);
    expect(report).toMatchObject({
      headline: { coverableChangedLines: 5, coveredChangedLines: 1 },
      uncoveredSpans: [
        { file: "src/foo.ts", side: "deletions", startLine: 11, endLine: 11 },
        { file: "src/foo.ts", side: "additions", startLine: 11, endLine: 13 },
      ],
    });
  });

  it("exits 2 when a refs-only artifact's diff cannot be re-derived, never a silent 100%", async () => {
    // Refs-only is the CLI default: with no embedded patch, coverage re-derives the diff
    // from `source`. When that repo is not present the diff cannot be produced, so coverage cannot
    // run — a shell-cannot-run (exit 2), never a silent 100%.
    const patchless: ReviewArtifact = { ...VALID, patch: undefined };
    const result = await runCli(["coverage", artifactFile(patchless)]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("git");
    expect(result.stdout).not.toContain("100%");
  });

  it("exits 2 on a frozen artifact whose patch carries no diff, never a silent 100%", async () => {
    // A rare imported/frozen artifact supplies its diff directly. The guard is on content,
    // not length: a blank or prose `patch` parses to no file, so there is no universe to score, and
    // it must not report 0-of-0 covered.
    for (const notADiff of ["   ", "this is not a diff at all"]) {
      const result = await runCli(["coverage", artifactFile({ ...VALID, patch: notADiff })]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("no diff to compute against");
      expect(result.stdout).not.toContain("100%");
    }
  });

  it("exits 2 when the artifact cannot be read or parsed", async () => {
    const missing = join(tmpdir(), "reviewer-cli-coverage-missing.reviewer.json");
    const unreadable = await runCli(["coverage", missing]);
    expect(unreadable.code).toBe(2);
    expect(unreadable.stderr).toContain("cannot read");

    const garbage = await runCli(["coverage", artifactFile("}{ not json")]);
    expect(garbage.code).toBe(2);
    expect(garbage.stderr).toContain("cannot compute coverage");
  });
});

describe("rvw schema", () => {
  it("emits the JSON Schema alone on --json, parseable and titled for the artifact", async () => {
    const result = await runCli(["schema", "--json"]);
    expect(result.code).toBe(0);
    const schema: unknown = JSON.parse(result.stdout);
    expect(schema).toMatchObject({ title: ".reviewer.json", type: "object" });
  });

  it("appends the rules JSON Schema cannot express in text mode, and omits them under --json", async () => {
    const text = await runCli(["schema"]);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("well-formed, not necessarily valid");
    expect(text.stdout).toContain("`rvw validate` and `rvw check` enforce both");
    // --json must stay a clean document: a trailing note would break `rvw schema --json > f`.
    const json = await runCli(["schema", "--json"]);
    expect(() => JSON.parse(json.stdout) as unknown).not.toThrow();
  });
});

describe("rvw skills", () => {
  it("lists authoring-review with the description read from its frontmatter", async () => {
    const result = await runCli(["skills"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("authoring-review");
    expect(result.stdout).toContain(".reviewer.json");
  });

  it("emits SkillSummary objects on --json", async () => {
    const result = await runCli(["skills", "--json"]);
    expect(result.code).toBe(0);
    const skills = JSON.parse(result.stdout) as { name: string; path: string }[];
    expect(skills.some((skill) => skill.name === "authoring-review")).toBe(true);
    expect(skills[0]?.path.endsWith("SKILL.md")).toBe(true);
  });

  it("prints one skill's path when named, so an agent can open it", async () => {
    const result = await runCli(["skills", "authoring-review"]);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toMatch(/\/skills\/authoring-review\/SKILL\.md$/);
  });

  it("exits 2 and names the known skills when asked for one that does not exist", async () => {
    const result = await runCli(["skills", "no-such-lens"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("no skill named no-such-lens");
    expect(result.stderr).toContain("authoring-review");
  });
});

describe("rvw check", () => {
  it("exits 0 on a valid, fully covered artifact", async () => {
    const result = await runCli(["check", artifactFile(FULLY_COVERED)]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("valid — every anchor places");
    expect(result.stdout).toContain("ready to hand over");
  });

  it("exits 1 on a mis-anchored artifact (validate hard-fails) and reports no coverage", async () => {
    const result = await runCli(["check", artifactFile(MIS_ANCHORED)]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("does not place");
    expect(result.stderr).toContain("src/foo.ts additions 50-50");
    // Coverage never ran: a mis-anchored artifact has nothing sound to measure.
    expect(result.stdout).not.toContain("coverage");
  });

  it("refuses a content-free artifact whose patch is not a diff, never `ready to hand over`", async () => {
    // The pre-handoff gate is the tamper defence: an artifact carrying prose where its diff
    // belongs, and no layer or comment to expose it, must not be blessed as valid and complete.
    const notADiff: ReviewArtifact = {
      ...FULLY_COVERED,
      patch: "this is not a diff at all",
      layers: [],
      comments: [],
    };
    const result = await runCli(["check", artifactFile(notADiff), "--require-complete"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("no diff to place anchors against");
    expect(result.stdout).not.toContain("ready to hand over");
    expect(result.stdout).not.toContain("100%");
  });

  it("exits 0 with a warning on a coverage gap — advisory by default", async () => {
    const result = await runCli(["check", artifactFile(GAP)]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("coverage 20% (1/5 changed lines)");
    expect(result.stdout).toContain("src/foo.ts additions 11-13");
    expect(result.stderr).toContain("warning: a coverable changed line is in no layer");
  });

  it("exits 1 on the same gap under --require-complete — the opt-in gate", async () => {
    const result = await runCli(["check", artifactFile(GAP), "--require-complete"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("incomplete");
    expect(result.stderr).not.toContain("warning:");
  });

  it("keeps the two severities distinct in the --json CheckReport", async () => {
    const refused = await runCli(["check", artifactFile(MIS_ANCHORED), "--json"]);
    expect(refused.code).toBe(1);
    expect(JSON.parse(refused.stdout)).toMatchObject({ ok: false, stage: "validate" });

    const gap = await runCli(["check", artifactFile(GAP), "--json"]);
    expect(gap.code).toBe(0);
    expect(JSON.parse(gap.stdout)).toMatchObject({
      ok: true,
      stage: "coverage",
      complete: false,
      requireComplete: false,
    });

    const gated = await runCli(["check", artifactFile(GAP), "--require-complete", "--json"]);
    expect(gated.code).toBe(1);
    expect(JSON.parse(gated.stdout)).toMatchObject({ ok: false, complete: false });
  });

  it("exits 2 when a refs-only artifact's diff cannot be re-derived — nothing to validate or score", async () => {
    // `rvw check` re-derives the diff from the artifact's own branch. A refs-only artifact
    // whose source repo is absent cannot re-derive, so neither the placement check nor coverage can
    // run: a shell-cannot-run (exit 2), distinct from "ran, not ready".
    const patchless: ReviewArtifact = { ...FULLY_COVERED, patch: undefined };
    const result = await runCli(["check", artifactFile(patchless)]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("git");
    expect(result.stdout).not.toContain("coverage");
  });

  it("exits 1 (ran, found problems) on garbage bytes, matching validate's posture", async () => {
    const result = await runCli(["check", artifactFile("}{ not json")]);
    expect(result.code).toBe(1);
  });

  it("exits 2 when the artifact cannot be read", async () => {
    const result = await runCli(["check", join(tmpdir(), "reviewer-check-missing.json")]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("cannot read");
  });
});

// `rvw open` only launches — the app validates the review's contents. Its pre-launch path
// checks (extension, existence, kind) are what these assert, because they are the arms that
// resolve without spawning `/usr/bin/open`; the launch decision itself is proven pure in
// `launch.test.ts`, and driving a real launch would depend on whether Reviewer is installed.
describe("rvw open", () => {
  it("refuses a path that is not a .reviewer.json before touching disk", async () => {
    const result = await runCli(["open", join(tmpdir(), "notes.txt")]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(".reviewer.json");
  });

  it("refuses a review path that does not exist, naming the failure not a stack trace", async () => {
    const missing = join(tmpdir(), "reviewer-open-missing.reviewer.json");
    const result = await runCli(["open", missing]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("cannot open");
    expect(result.stderr).not.toContain("at Object.");
  });

  it("refuses a directory that merely ends .reviewer.json — a review is a file", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "reviewer-open-")), "decoy.reviewer.json");
    mkdirSync(dir);
    const result = await runCli(["open", dir]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("not a file");
  });

  it("exits 2 when the artifact positional is missing", async () => {
    expect((await runCli(["open"])).code).toBe(2);
  });
});
