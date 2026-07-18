import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { Application, StricliProcess } from "@stricli/core";
import { run } from "@stricli/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ReviewArtifact, ReviewLayer } from "../src/shared/review";
import { coverageOfPatch, type FileUniverse } from "../src/tools/review-coverage";
import { artifactDiff, capturePatch } from "./git";
import { app } from "./app";
import { normalizeExitCode, type LocalContext } from "./context";

// The live-range surface driven against a real git fixture in a temp dir — the only way to
// prove the byte-stable capture and the exit-2 refusals honestly. The CLI runs the same way
// the shipped entrypoint does (Stricli `run`), bound to capturing streams. Fixture
// construction is isolated from the developer's git config; the capture must itself be
// config-proof (it pins the wire format).

const FIXTURE_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@test.local",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@test.local",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: FIXTURE_ENV });
}

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

let root: string;
let repo: string;
let baseSha: string;
let headSha: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "reviewer-live-range-")));
  repo = join(root, "work");
  mkdirSync(repo);
  git(repo, "init", "-b", "main");

  writeFileSync(join(repo, "alpha.ts"), "a1\na2\na3\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  baseSha = git(repo, "rev-parse", "HEAD").trim();

  // alpha.ts: line 2 rewritten (deletion 2 / addition 2), line 4 appended (addition 4);
  // beta.ts added whole. Two changed files, both coverable.
  writeFileSync(join(repo, "alpha.ts"), "a1\na2 changed\na3\na4\n");
  writeFileSync(join(repo, "beta.ts"), "b1\nb2\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "head");
  headSha = git(repo, "rev-parse", "HEAD").trim();
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The changed-line universe an agent reads from `rvw anchors --json`, parsed back. */
async function universe(): Promise<FileUniverse[]> {
  const result = await runCli([
    "anchors",
    "--repo",
    repo,
    "--base",
    baseSha,
    "--head",
    headSha,
    "--json",
  ]);
  expect(result.code).toBe(0);
  return JSON.parse(result.stdout) as FileUniverse[];
}

/** Author a single layer covering every span in the universe except those of the excluded
 * files — the "author against real numbers" round-trip the anchors listing exists for. */
function draftCovering(
  files: FileUniverse[],
  exclude: readonly string[],
): { layers: ReviewLayer[] } {
  const ranges = files.flatMap((file) =>
    file.coverable && !exclude.includes(file.file)
      ? file.spans.map((span) => ({
          file: file.file,
          side: span.side,
          startLine: span.startLine,
          endLine: span.endLine,
        }))
      : [],
  );
  return { layers: [{ id: "l1", label: "Walk", summary: "the change", kind: "feature", ranges }] };
}

function draftFile(draft: { layers: ReviewLayer[] }): string {
  const dir = mkdtempSync(join(tmpdir(), "reviewer-draft-"));
  const file = join(dir, "draft.json");
  writeFileSync(file, JSON.stringify(draft));
  return file;
}

describe("rvw anchors", () => {
  it("lists every changed file with its per-side changed spans", async () => {
    const result = await runCli(["anchors", "--repo", repo, "--base", baseSha, "--head", headSha]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("2 changed file(s)");
    expect(result.stdout).toContain("alpha.ts");
    expect(result.stdout).toContain("beta.ts");
    expect(result.stdout).toContain("additions");
    expect(result.stdout).toContain("deletions");
  });

  it("--json round-trips into an anchor an agent could author, matching coverage's universe", async () => {
    const files = await universe();
    const alpha = files.find((file) => file.file === "alpha.ts");
    expect(alpha?.coverable).toBe(true);
    // beta.ts is a brand-new file: additions only, a single contiguous span.
    const beta = files.find((file) => file.file === "beta.ts");
    if (beta?.coverable !== true) throw new Error("expected beta.ts coverable");
    expect(beta.spans).toEqual([{ side: "additions", startLine: 1, endLine: 2 }]);

    // The spans are exactly what coverage treats as the universe: a draft that covers every
    // listed span reports 100%, none uncovered — the anchor authored from the listing lands.
    const capture = capturePatch(repo, baseSha, headSha);
    if (!capture.ok) throw new Error(capture.message);
    const scored = coverageOfPatch(capture.patch, draftCovering(files, []).layers);
    if (!scored.ok) throw new Error("expected a report over the captured patch");
    expect(scored.report.headline.coveredChangedLines).toBe(
      scored.report.headline.coverableChangedLines,
    );
    expect(scored.report.uncoveredSpans).toEqual([]);
  });
});

describe("rvw coverage --draft (live range)", () => {
  it("reports the exact uncovered file/spans of a draft that skips a changed file", async () => {
    const files = await universe();
    const gap = draftFile(draftCovering(files, ["beta.ts"]));
    const result = await runCli([
      "coverage",
      "--repo",
      repo,
      "--base",
      baseSha,
      "--head",
      headSha,
      "--draft",
      gap,
    ]);
    // Advisory by default: the gap is on stdout but the exit stays 0.
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("uncovered      beta.ts");
    expect(result.stdout).toContain("beta.ts additions 1-2");
  });

  it("exits 1 under --require-complete on a gap, and 0 on a complete draft — the mid-draft loop", async () => {
    const files = await universe();

    const gap = draftFile(draftCovering(files, ["beta.ts"]));
    const gated = await runCli([
      "coverage",
      "--repo",
      repo,
      "--base",
      baseSha,
      "--head",
      headSha,
      "--draft",
      gap,
      "--require-complete",
    ]);
    expect(gated.code).toBe(1);

    const complete = draftFile(draftCovering(files, []));
    const passed = await runCli([
      "coverage",
      "--repo",
      repo,
      "--base",
      baseSha,
      "--head",
      headSha,
      "--draft",
      complete,
      "--require-complete",
    ]);
    expect(passed.code).toBe(0);
    expect(passed.stdout).toContain("coverage 100%");
  });

  it("exits 2 on a non-object draft rather than a misleading coverage number", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reviewer-draft-bad-"));
    const bad = join(dir, "draft.json");
    writeFileSync(bad, '"just a string"');
    const result = await runCli([
      "coverage",
      "--repo",
      repo,
      "--base",
      baseSha,
      "--head",
      headSha,
      "--draft",
      bad,
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("no valid `layers`");
  });
});

describe("live-range refusals (exit 2, clean message)", () => {
  it("rejects a rev-expression ref before any spawn", async () => {
    const result = await runCli(["anchors", "--repo", repo, "--base", "HEAD~2", "--head", headSha]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--base HEAD~2 is not a valid ref");
    expect(result.stderr).not.toContain("Error:");
  });

  it("refuses a git failure (unknown ref) with an actionable message, not a stack trace", async () => {
    const result = await runCli([
      "coverage",
      "--repo",
      repo,
      "--base",
      baseSha,
      "--head",
      "no-such-branch",
      "--draft",
      "unused.json",
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("git");
    expect(result.stderr).toContain("failed");
    expect(result.stderr).not.toContain("at Object.");
  });
});

describe("capture ↔ frozen-artifact parity", () => {
  it("captured patch coverage equals resolving a frozen artifact's diff and running the coverage core", async () => {
    const capture = capturePatch(repo, baseSha, headSha);
    if (!capture.ok) throw new Error(capture.message);

    const layers: ReviewLayer[] = [
      {
        id: "l1",
        label: "Walk",
        summary: "the change",
        kind: "feature",
        ranges: [{ file: "alpha.ts", side: "additions", startLine: 2, endLine: 2 }],
      },
    ];

    // The live path: coverage over the freshly-captured patch.
    const live = coverageOfPatch(capture.patch, layers);
    if (!live.ok) throw new Error("expected a report over the captured patch");

    // The frozen-artifact path: the same bytes embedded into a rare frozen artifact, whose diff
    // the CLI resolves via `artifactDiff` (returned verbatim, no git) and scores by the same core.
    // Identical bytes + identical core ⇒ identical report.
    const artifact: ReviewArtifact = {
      version: 1,
      source: {
        kind: "local",
        repo: { path: capture.repoPath, name: "work" },
        base: baseSha,
        head: headSha,
      },
      patch: capture.patch,
      comments: [],
      layers,
    };
    const diff = artifactDiff(artifact);
    if (!diff.ok) throw new Error(diff.message);
    const frozen = coverageOfPatch(diff.patch, artifact.layers);
    if (!frozen.ok) throw new Error("expected a frozen-artifact report");

    expect(live.report).toEqual(frozen.report);
  });
});
