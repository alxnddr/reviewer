import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rangeDiffArgs } from "../src/shared/node/git-diff";
import type { ReviewArtifact, ReviewLayerInput } from "../src/shared/review";
import { coverageOfPatch, type FileUniverse } from "../src/tools/review-coverage";
import { artifactDiff, capturePatch, git } from "./git";
import { FIXTURE_ENV, fixtureGit, runCli } from "./fixtures";

// The live-range surface — `rvw diff` and the range resolution behind it — driven against a
// real git fixture in a temp dir, the only way to prove the byte-stable capture and the exit-2
// refusals honestly. The CLI runs the same way the shipped entrypoint does (Stricli `run`),
// bound to capturing streams. Fixture construction is isolated from the developer's git config;
// the capture must itself be config-proof (it pins the wire format).
//
// The claim that matters here is `rvw diff`'s reason for existing: its stdout is *the* patch
// the gate judges anchors against, byte for byte. The authoring instructions used to spell out
// the git incantation for the agent to run by hand, which meant the CLI's private capture
// config lived in prose that could drift from the code; the parity assertion below is what
// makes that impossible now.

let root: string;
let repo: string;
let baseSha: string;
let headSha: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "reviewer-live-range-")));
  repo = join(root, "work");
  mkdirSync(repo);
  fixtureGit(repo, "init", "-b", "main");

  writeFileSync(join(repo, "alpha.ts"), "a1\na2\na3\n");
  fixtureGit(repo, "add", ".");
  fixtureGit(repo, "commit", "-m", "base");
  baseSha = fixtureGit(repo, "rev-parse", "HEAD").trim();

  // alpha.ts: line 2 rewritten (deletion 2 / addition 2), line 4 appended (addition 4);
  // beta.ts added whole. Two changed files, both coverable.
  writeFileSync(join(repo, "alpha.ts"), "a1\na2 changed\na3\na4\n");
  writeFileSync(join(repo, "beta.ts"), "b1\nb2\n");
  fixtureGit(repo, "add", ".");
  fixtureGit(repo, "commit", "-m", "head");
  headSha = fixtureGit(repo, "rev-parse", "HEAD").trim();
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function range(): string[] {
  return ["--repo", repo, "--base", baseSha, "--head", headSha];
}

/** The changed-line universe an agent reads from `rvw diff --json`, parsed back. */
async function universe(): Promise<FileUniverse[]> {
  const result = await runCli(["diff", ...range(), "--json"]);
  expect(result.code).toBe(0);
  return JSON.parse(result.stdout) as FileUniverse[];
}

describe("rvw diff", () => {
  it("prints the range's patch verbatim — the exact bytes the gate places anchors against", async () => {
    // The whole point of the verb. `capturePatch` is what `emit` and `check` gate with, so
    // equality here is the guarantee that an anchor authored from this output places: there is
    // one capture, not a documented incantation an agent runs alongside it.
    const gated = capturePatch(FIXTURE_ENV, repo, baseSha, headSha);
    if (!gated.ok) throw new Error(gated.message);

    const result = await runCli(["diff", ...range()]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(gated.patch);
    // stdout is a patch and nothing else: no header naming the range, so it pipes.
    expect(result.stdout.startsWith("diff --git ")).toBe(true);
  });

  it("captures through the pinned wire format, whatever the ambient git config says", async () => {
    // `rangeDiffArgs` is the shared config the app's runner uses too. A drift between the two
    // would produce a patch whose paths or line numbers no longer match the authored anchors.
    const direct = git(FIXTURE_ENV, repo, rangeDiffArgs(baseSha, headSha));
    if (!direct.ok) throw new Error(direct.message);
    const result = await runCli(["diff", ...range()]);
    expect(result.stdout).toBe(direct.stdout);
  });

  it("lists every changed file with its per-side changed spans under --json", async () => {
    const files = await universe();
    expect(files.map((file) => file.file)).toEqual(["alpha.ts", "beta.ts"]);

    const alpha = files.find((file) => file.file === "alpha.ts");
    expect(alpha?.coverable).toBe(true);
    // beta.ts is a brand-new file: additions only, a single contiguous span.
    const beta = files.find((file) => file.file === "beta.ts");
    if (beta?.coverable !== true) throw new Error("expected beta.ts coverable");
    expect(beta.spans).toEqual([{ side: "additions", startLine: 1, endLine: 2 }]);
  });

  it("--json round-trips into an anchor an agent could author, matching coverage's universe", async () => {
    const files = await universe();

    // The spans are exactly what coverage treats as the universe: a draft that covers every
    // listed span reports 100%, none uncovered — the anchor authored from the listing lands.
    const captured = capturePatch(FIXTURE_ENV, repo, baseSha, headSha);
    if (!captured.ok) throw new Error(captured.message);
    const scored = coverageOfPatch(captured.patch, [{ ranges: everySpan(files) }]);
    if (!scored.ok) throw new Error("expected a report over the captured patch");
    expect(scored.report.headline.coveredChangedLines).toBe(
      scored.report.headline.coverableChangedLines,
    );
    expect(scored.report.uncoveredSpans).toEqual([]);
  });

  it("defaults the whole range to the repo the caller is standing in", async () => {
    // Where the caller is standing is a context field, so this is the repo the run is *given*
    // rather than a `process.chdir` the whole worker would have shared.
    const defaulted = await runCli(["diff"], { cwd: repo });
    expect(defaulted.code).toBe(0);
    // `main` is checked out and has no upstream, so the base falls back to the repo's default
    // branch — which is `main` itself, whose merge-base with HEAD is HEAD. An empty diff, and
    // an honest one: the range says there is nothing between here and where this started.
    expect(defaulted.stdout).toBe("");

    // Naming only what differs is the ergonomic the defaults exist for.
    const fromBase = await runCli(["diff", "--base", baseSha], { cwd: repo });
    expect(fromBase.code).toBe(0);
    expect(fromBase.stdout).toContain("alpha.ts");
    expect(fromBase.stdout).toContain("beta.ts");
  });
});

describe("live-range refusals (exit 2, clean message)", () => {
  it("accepts a rev-expression rather than refusing it, and refuses only what git cannot resolve", async () => {
    // `HEAD~1` used to be rejected outright as "not a valid ref", which sent the agent to
    // pre-resolve every endpoint by hand. It resolves now; a revision that names nothing does not.
    const expression = await runCli(["diff", "--repo", repo, "--base", "HEAD~1"]);
    expect(expression.code).toBe(0);
    expect(expression.stdout).toContain("alpha.ts");

    const unknown = await runCli(["diff", "--repo", repo, "--base", "no-such-branch"]);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("--base no-such-branch");
    expect(unknown.stderr).not.toContain("Error:");
  });

  it("refuses a directory that is not a repo with an actionable message, not a stack trace", async () => {
    const result = await runCli(["diff", "--repo", root, "--base", baseSha, "--head", headSha]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("git");
    expect(result.stderr).not.toContain("at Object.");
  });

  it("reports a cannot-run as a structured envelope when the caller asked for JSON", async () => {
    const result = await runCli(["diff", "--repo", repo, "--base", "no-such-branch", "--json"]);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code: "badRef" } });
    expect(result.stderr).toBe("");
  });
});

describe("capture ↔ frozen-artifact parity", () => {
  it("captured patch coverage equals resolving a frozen artifact's diff and running the coverage core", () => {
    const captured = capturePatch(FIXTURE_ENV, repo, baseSha, headSha);
    if (!captured.ok) throw new Error(captured.message);

    const layers: ReviewLayerInput[] = [
      {
        label: "Walk",
        summary: "the change",
        ranges: [{ file: "alpha.ts", side: "additions", startLine: 2, endLine: 2 }],
        children: [],
      },
    ];

    // The live path: coverage over the freshly-captured patch.
    const live = coverageOfPatch(captured.patch, layers);
    if (!live.ok) throw new Error("expected a report over the captured patch");

    // The frozen-artifact path: the same bytes embedded into a rare frozen artifact, whose diff
    // the CLI resolves via `artifactDiff` (returned verbatim, no git) and scores by the same core.
    // Identical bytes + identical core ⇒ identical report.
    const artifact: ReviewArtifact = {
      repo,
      base: baseSha,
      head: headSha,
      patch: captured.patch,
      comments: [],
      layers,
    };
    const diff = artifactDiff(FIXTURE_ENV, artifact);
    if (!diff.ok) throw new Error(diff.message);
    const frozen = coverageOfPatch(diff.patch, artifact.layers);
    if (!frozen.ok) throw new Error("expected a frozen-artifact report");

    expect(live.report).toEqual(frozen.report);
  });
});

/** Every coverable span in the universe, as anchors — the "author against real numbers"
 * round-trip the `--json` listing exists for. */
function everySpan(files: readonly FileUniverse[]) {
  return files.flatMap((file) =>
    file.coverable
      ? file.spans.map((span) => ({
          file: file.file,
          side: span.side,
          startLine: span.startLine,
          endLine: span.endLine,
        }))
      : [],
  );
}
