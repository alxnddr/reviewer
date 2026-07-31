import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCommand, buildRouteMap } from "@stricli/core";
import { describe, expect, it } from "vitest";
import type { ReviewArtifact } from "../src/shared/review";
import { buildRvwApplication } from "./app";
import type { LocalContext } from "./context";
import { REPO_ROOT, runCli, type CliResult } from "./fixtures";

// The `rvw` surface driven the way the shipped entrypoint drives it — through Stricli's
// `run` against the real application — but bound to capturing streams so the whole
// exit-code contract (0 ready / 1 problems / 2 cannot-run) and both output channels are
// asserted in-process, no spawn. Routing, `--help`, `--json`, and every artifact-shaped verb's
// behavior resolve here; the live-range verbs need a real repo (`live-range.test.ts`,
// `emit.test.ts`), `index.test.ts` proves the same codes on a real process, and
// `portability.test.ts` proves the bundle carries them into a foreign repo.

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
  repo: "/repo",
  base: "main",
  head: "feature",
  patch: PATCH,
  comments: [{ file: "src/foo.ts", side: "additions", startLine: 11, endLine: 13, body: "note" }],
  layers: [
    {
      label: "Leaf",
      summary: "child",
      description: "Adds [bar](src/bar.ts).",
      ranges: [{ file: "src/bar.ts", side: "additions", startLine: 2, endLine: 2 }],
      children: [],
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

/** Write an artifact (object or raw string) to a temp file and return its path, so
 * check reads real untrusted bytes exactly as it does in production. */
function artifactFile(artifact: ReviewArtifact | string): string {
  const dir = mkdtempSync(join(tmpdir(), "reviewer-cli-"));
  const file = join(dir, "artifact.reviewer.json");
  writeFileSync(file, typeof artifact === "string" ? artifact : JSON.stringify(artifact));
  return file;
}

/** The `{ok:false,error:{code,message}}` document every verb owes a `--json` caller on a
 * cannot-run, parsed back so a test asserts on the code rather than on prose. */
function errorEnvelope(result: CliResult): { code: string; message: string } {
  const parsed = JSON.parse(result.stdout) as {
    ok: boolean;
    error: { code: string; message: string };
  };
  expect(parsed.ok).toBe(false);
  return parsed.error;
}

describe("rvw dispatch surface", () => {
  it("routes a known verb and recognizes --help and --json uniformly", async () => {
    const help = await runCli(["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("rvw");
    // --json is accepted on check without being mistaken for the positional artifact.
    const json = await runCli(["check", artifactFile(VALID), "--json"]);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual({ ok: true, stage: "validate" });
  });

  it("exits 2 on an unknown verb rather than routing it", async () => {
    const result = await runCli(["frobnicate"]);
    expect(result.code).toBe(2);
  });

  it("exits 2 when a required positional argument is missing", async () => {
    const result = await runCli(["check"]);
    expect(result.code).toBe(2);
  });

  it("routes all six review verbs — no verb is left an unimplemented seam", async () => {
    const help = await runCli(["--help"]);
    for (const verb of ["emit", "check", "diff", "open", "schema", "skills"]) {
      expect(help.stdout).toContain(`rvw ${verb}`);
    }
    expect(help.stdout).not.toContain("not yet implemented");
  });

  it("no longer routes the verbs that were folded into check and diff", async () => {
    // `validate` is `check` without its second half, `coverage` is `check --coverage`, and
    // `anchors` is `diff --json`. Each stays deleted rather than lingering as an alias: an
    // agent choosing between two spellings of one verb is an agent that can choose wrong.
    for (const gone of ["validate", "coverage", "anchors"]) {
      expect((await runCli([gone, artifactFile(VALID)])).code).toBe(2);
    }
    const help = await runCli(["--help"]);
    expect(help.stdout).not.toContain("rvw validate");
    expect(help.stdout).not.toContain("rvw coverage");
    expect(help.stdout).not.toContain("rvw anchors");
  });

  it("answers --version and -v with package.json's version and the file it is running from", async () => {
    // Read off disk rather than imported, so this is the version the app ships under and not
    // the same constant the CLI already believes. The path half is what makes the flag worth
    // having — `src/main/cli-install.ts` can report that some other `rvw` won the PATH, and this
    // is the only way to ask which one just ran — so it is asserted to name a file that exists.
    const { version } = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      version: string;
    };
    for (const flag of ["--version", "-v"]) {
      const result = await runCli([flag]);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      const printed = /^(?<version>\S+) \((?<path>.+)\)$/u.exec(result.stdout.trim());
      expect(printed?.groups?.version).toBe(version);
      expect(existsSync(printed?.groups?.path ?? "")).toBe(true);
    }
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
    const result = await runCli(["boom"], {}, throwingApp);
    expect(result.code).toBe(2);
  });
});

// The same PATCH universe: src/foo.ts additions {11,12,13} + deletion {11}, src/bar.ts
// addition {2} — five coverable changed lines. FULLY_COVERED spans every one; GAP leaves
// all of foo in no layer.
const FULLY_COVERED: ReviewArtifact = {
  ...VALID,
  layers: [
    {
      label: "All",
      summary: "covers everything",
      ranges: [
        { file: "src/foo.ts", side: "additions", startLine: 11, endLine: 13 },
        { file: "src/foo.ts", side: "deletions", startLine: 11, endLine: 11 },
        { file: "src/bar.ts", side: "additions", startLine: 2, endLine: 2 },
      ],
      children: [],
    },
  ],
};

// VALID's lone layer covers only src/bar.ts addition 2, so all of src/foo.ts is a gap.
const GAP: ReviewArtifact = VALID;

describe("rvw check — the validation half", () => {
  it("exits 0 and reports valid on an artifact whose anchors all place, scoring nothing it was not asked to", async () => {
    const result = await runCli(["check", artifactFile(VALID)]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("valid — every anchor places");
    // The default run answers one question. A coverage number nobody asked for is context the
    // caller pays for and did not want.
    expect(result.stdout).not.toContain("coverage");
    expect(result.stderr).toBe("");
  });

  it("exits 1 with the exact locator on a mis-anchored artifact, and reports no coverage", async () => {
    const result = await runCli(["check", artifactFile(MIS_ANCHORED), "--coverage"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("does not place");
    expect(result.stderr).toContain("src/foo.ts additions 50-50");
    // Coverage never ran: a mis-anchored artifact has nothing sound to measure.
    expect(result.stdout).not.toContain("coverage");
  });

  it("exits 1 (ran, found problems) on garbage bytes without throwing", async () => {
    const result = await runCli(["check", artifactFile("}{ not json")]);
    expect(result.code).toBe(1);
  });

  it("accepts a comments-only and a layers-only artifact — each is a whole review", async () => {
    const commentsOnly: ReviewArtifact = { ...VALID, layers: [] };
    const layersOnly: ReviewArtifact = { ...VALID, comments: [] };
    expect((await runCli(["check", artifactFile(commentsOnly)])).code).toBe(0);
    expect((await runCli(["check", artifactFile(layersOnly)])).code).toBe(0);
  });

  it("emits the structured CheckReport as JSON on --json, exit 1 when not ready", async () => {
    const result = await runCli(["check", artifactFile(MIS_ANCHORED), "--json"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, stage: "validate" });
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
});

describe("rvw check --coverage — the scoring half", () => {
  it("exits 0 with a 100% headline when every changed line is in a layer, and stays 0 under --require-complete", async () => {
    const covered = await runCli(["check", artifactFile(FULLY_COVERED), "--coverage"]);
    expect(covered.code).toBe(0);
    expect(covered.stdout).toContain("coverage 100% (5/5 changed lines)");
    expect(covered.stdout).toContain("ready to hand over");

    const gated = await runCli(["check", artifactFile(FULLY_COVERED), "--require-complete"]);
    expect(gated.code).toBe(0);
  });

  it("treats --require-complete as implying --coverage, so a caller never passes both", async () => {
    const result = await runCli(["check", artifactFile(FULLY_COVERED), "--require-complete"]);
    expect(result.stdout).toContain("coverage 100%");
  });

  it("reports a gap but exits 0 by default (advisory), warning once on stderr", async () => {
    const result = await runCli(["check", artifactFile(GAP), "--coverage"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("coverage 20% (1/5 changed lines)");
    expect(result.stdout).toContain("uncovered      src/foo.ts");
    expect(result.stderr).toContain("warning: a coverable changed line is in no layer");
  });

  it("never flattens the uncovered spans into the text report", async () => {
    // The reason this verb was trimmed: on a real range the flattened spans were ~200 lines of
    // output for a caller who asked whether the review was ready. They are still in --json.
    const text = await runCli(["check", artifactFile(GAP), "--coverage"]);
    expect(text.stdout).not.toContain("uncovered spans:");
    expect(text.stdout).not.toContain("src/foo.ts additions 11-13");

    const json = await runCli(["check", artifactFile(GAP), "--coverage", "--json"]);
    expect(JSON.parse(json.stdout)).toMatchObject({
      coverage: {
        uncoveredSpans: [
          { file: "src/foo.ts", side: "deletions", startLine: 11, endLine: 11 },
          { file: "src/foo.ts", side: "additions", startLine: 11, endLine: 13 },
        ],
      },
    });
  });

  it("caps the per-file rollup and says how many files it left out", async () => {
    const wide = wideArtifact(14);
    const result = await runCli(["check", artifactFile(wide), "--coverage"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("f00.ts");
    expect(result.stdout).toContain("f09.ts");
    // Eleventh onward is a count, not a line each — the whole point of the cap.
    expect(result.stdout).not.toContain("f10.ts");
    expect(result.stdout).toContain("… and 4 more file(s)");

    // --json is unaffected: a caller that wants all fourteen asks for the document.
    const json = await runCli(["check", artifactFile(wide), "--coverage", "--json"]);
    const report = JSON.parse(json.stdout) as { coverage: { files: unknown[] } };
    expect(report.coverage.files).toHaveLength(14);
  });

  it("does not warn a review that authored no layers — it is not incomplete, it is a different review", async () => {
    // With layers optional, "a coverable changed line is in no layer" is the *expected* state of
    // a comments-only review. Warning about it every time would make the common path noisy.
    const commentsOnly: ReviewArtifact = { ...VALID, layers: [] };
    const result = await runCli(["check", artifactFile(commentsOnly), "--coverage"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("coverage 0% (0/5 changed lines)");
    expect(result.stderr).toBe("");

    // The opt-in gate still means what it says: a caller that asked for complete coverage and
    // wrote no layers has not got it.
    const gated = await runCli(["check", artifactFile(commentsOnly), "--require-complete"]);
    expect(gated.code).toBe(1);
    expect(gated.stderr).toContain("incomplete");
  });

  it("exits 1 on a gap under --require-complete — the opt-in gate", async () => {
    const result = await runCli(["check", artifactFile(GAP), "--require-complete"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("incomplete");
    expect(result.stderr).not.toContain("warning:");
  });

  it("keeps the two severities distinct in the --json CheckReport", async () => {
    const refused = await runCli(["check", artifactFile(MIS_ANCHORED), "--json"]);
    expect(refused.code).toBe(1);
    expect(JSON.parse(refused.stdout)).toMatchObject({ ok: false, stage: "validate" });

    const gap = await runCli(["check", artifactFile(GAP), "--coverage", "--json"]);
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
    // whose source repo is absent cannot re-derive, so neither the placement check nor coverage
    // can run: a shell-cannot-run (exit 2), distinct from "ran, not ready".
    const patchless: ReviewArtifact = { ...FULLY_COVERED, patch: undefined };
    const result = await runCli(["check", artifactFile(patchless), "--coverage"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("git");
    expect(result.stdout).not.toContain("coverage");
  });
});

/** An artifact over a diff of `count` one-line files, none of them in a layer — the shape that
 * makes the rollup cap visible. */
function wideArtifact(count: number): ReviewArtifact {
  const patch = Array.from({ length: count }, (_, index) => {
    const name = `f${String(index).padStart(2, "0")}.ts`;
    return [
      `diff --git a/${name} b/${name}`,
      "index 1111111..2222222 100644",
      `--- a/${name}`,
      `+++ b/${name}`,
      "@@ -1,1 +1,2 @@",
      " keep1",
      "+added2",
    ].join("\n");
  }).join("\n");
  return {
    repo: "/repo",
    base: "main",
    head: "feature",
    patch: `${patch}\n`,
    comments: [{ file: "f00.ts", side: "additions", startLine: 2, endLine: 2, body: "note" }],
    layers: [],
  };
}

// Every verb that takes `--json` owes a JSON caller a structured failure on exit 2 too — an
// agent that opted out of prose should never have to parse a stderr line to learn why the shell
// could not run. The codes are the contract; the messages are not.
describe("the --json failure envelope", () => {
  it("names an unreadable artifact rather than leaving check's caller a bare stderr line", async () => {
    const missing = join(tmpdir(), "reviewer-cli-does-not-exist.reviewer.json");
    const result = await runCli(["check", missing, "--json"]);
    expect(result.code).toBe(2);
    expect(errorEnvelope(result).code).toBe("artifactUnreadable");
    expect(result.stderr).toBe("");
  });

  it("names an absent repo as a git failure, not as a review verdict", async () => {
    const patchless: ReviewArtifact = { ...VALID, patch: undefined };
    const result = await runCli(["check", artifactFile(patchless), "--json"]);
    expect(result.code).toBe(2);
    expect(errorEnvelope(result).code).toBe("gitFailed");
  });

  it("names a path that is not a review, from open", async () => {
    const result = await runCli(["open", join(tmpdir(), "notes.txt"), "--json"]);
    expect(result.code).toBe(2);
    expect(errorEnvelope(result).code).toBe("badArtifactPath");
    expect(result.stderr).toBe("");
  });

  it("names a skill nobody ships", async () => {
    const result = await runCli(["skills", "no-such-lens", "--json"]);
    expect(result.code).toBe(2);
    expect(errorEnvelope(result).code).toBe("noSuchSkill");
  });

  it("keeps the plain-text channel unchanged for a caller who did not ask for JSON", async () => {
    const result = await runCli(["open", join(tmpdir(), "notes.txt")]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(".reviewer.json");
    expect(result.stdout).toBe("");
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
    expect(text.stdout).toContain("`rvw emit` and `rvw check` enforce both");
    // --json must stay a clean document: a trailing note would break `rvw schema --json > f`.
    const json = await runCli(["schema", "--json"]);
    expect(() => JSON.parse(json.stdout) as unknown).not.toThrow();
  });
});

describe("rvw skills", () => {
  it("lists present-review with the description read from its frontmatter", async () => {
    const result = await runCli(["skills"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("present-review");
    expect(result.stdout).toContain("Reviewer app");
  });

  it("emits SkillSummary objects on --json", async () => {
    const result = await runCli(["skills", "--json"]);
    expect(result.code).toBe(0);
    const skills = JSON.parse(result.stdout) as { name: string; path: string }[];
    expect(skills.some((skill) => skill.name === "present-review")).toBe(true);
    expect(skills[0]?.path.endsWith("SKILL.md")).toBe(true);
  });

  it("prints one skill's path when named, so an agent can open it", async () => {
    const result = await runCli(["skills", "present-review"]);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toMatch(/\/skills\/present-review\/SKILL\.md$/u);
  });

  it("exits 2 and names the known skills when asked for one that does not exist", async () => {
    const result = await runCli(["skills", "no-such-lens"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("no skill named no-such-lens");
    expect(result.stderr).toContain("present-review");
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
