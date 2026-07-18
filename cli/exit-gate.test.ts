import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  reviewDiffFor,
  ReviewArtifact,
  type ReviewAnchor,
  type ReviewComment,
  type ReviewLayer,
  type ReviewStamp,
} from "../src/shared/review";
import { importReviewFromPath, reviewPathFromArgv } from "../src/main/review/guard";
import { parsePatch } from "../src/renderer/src/lib/diff/patch";
import {
  buildCommentItems,
  type CommentUiState,
} from "../src/renderer/src/lib/diff/comment-annotations";
import type { CoverageReport, FileUniverse } from "../src/tools/review-coverage";
import { artifactDiff } from "./git";
import type { CheckReport } from "./commands/check";
import {
  installBundle,
  rvw,
  walkthroughRepo,
  type ForeignRepo,
  type InstalledCli,
  type RvwResult,
} from "./fixtures";

// The exit gate. What is proven here is the composed claim: an agent, with nothing but the
// distributed `rvw` bundle, authors a **complete** and **valid** review of a repo that is not
// the Reviewer checkout, and it opens with zero manual fixing.
//
// So every command below is spawned as `node dist/rvw.js` with the foreign repo as cwd — the
// bundle boundary and the repo boundary are both real. Nothing is mocked, and nothing
// short-circuits into the in-process cores except the final step, which is the *app's* own open
// and render path reading the bytes the CLI actually wrote.
//
// A green happy path is not a passed gate, so the two negatives are asserted with the same
// force as the positive: a draft that forgets a changed file is caught by `coverage
// --require-complete` with the exact uncovered span (exit 1), and a mis-anchored draft is
// caught before any bytes reach disk (`emit`, exit 1) and again on the wire (`validate`, exit
// 1) with the exact locator. Neither ever reports ready. And the two files a machine cannot
// score — a binary and a pure rename — are reported non-coverable, never handed to the agent
// as work to do.

const ARTIFACT = "walkthrough.reviewer.json";

// The walkthrough the agent authors, in reading order (the app re-sorts nothing). Its
// anchors are not invented here — `authored anchors are read from the printed universe` proves
// every one of them falls inside a span `rvw anchors` listed for this range.
const ENGINE_LAYER: ReviewLayer = {
  id: "engine",
  label: "Engine",
  summary: "Two entry points rewritten, far apart in the file",
  description: "Rewrites the [engine](src/engine.ts) entry points.",
  kind: "feature",
  ranges: [
    { file: "src/engine.ts", side: "deletions", startLine: 2, endLine: 2 },
    { file: "src/engine.ts", side: "deletions", startLine: 18, endLine: 18 },
    { file: "src/engine.ts", side: "additions", startLine: 2, endLine: 2 },
    { file: "src/engine.ts", side: "additions", startLine: 18, endLine: 18 },
  ],
};
const UTIL_LAYER: ReviewLayer = {
  id: "util",
  label: "Util",
  summary: "The helper the engine leans on follows suit",
  kind: "feature",
  ranges: [
    { file: "src/util.ts", side: "deletions", startLine: 2, endLine: 2 },
    { file: "src/util.ts", side: "additions", startLine: 2, endLine: 2 },
  ],
};
/** The layer the agent adds *because coverage told it to* — the one file a walkthrough forgets. */
const CHANGELOG_LAYER: ReviewLayer = {
  id: "changelog",
  label: "Changelog",
  summary: "The change is announced",
  kind: "docs",
  ranges: [{ file: "docs/CHANGELOG.md", side: "additions", startLine: 2, endLine: 3 }],
};

const COMMENTS: ReviewComment[] = [
  {
    file: "src/engine.ts",
    side: "additions",
    startLine: 2,
    endLine: 2,
    body: "why the first entry point moved",
  },
  {
    file: "src/util.ts",
    side: "additions",
    startLine: 2,
    endLine: 2,
    body: "why the helper had to follow",
  },
];

/** The anchor an agent could only produce by guessing: `src/engine.ts` is in the diff, but no
 * hunk of it covers line 900. Both deny-paths (`emit`'s pre-write gate and `validate`'s
 * on-the-wire check) must name exactly this locator. */
const MIS_ANCHOR: ReviewAnchor = {
  file: "src/engine.ts",
  side: "additions",
  startLine: 900,
  endLine: 901,
};
const MIS_ANCHOR_LOCATOR = "src/engine.ts additions 900-901";

/** The draft an agent hands `rvw`: only `comments` and `layers`; the range and its patch are
 * the CLI's to capture. */
type Draft = { comments: ReviewComment[]; layers: ReviewLayer[] };

const GAP_DRAFT: Draft = { comments: COMMENTS, layers: [ENGINE_LAYER, UTIL_LAYER] };
const COMPLETE_DRAFT: Draft = {
  comments: COMMENTS,
  layers: [ENGINE_LAYER, UTIL_LAYER, CHANGELOG_LAYER],
};

let cli: InstalledCli;
let repo: ForeignRepo;

beforeAll(() => {
  cli = installBundle();
  repo = walkthroughRepo();
  // Both boundaries the gate rests on, asserted rather than assumed: the bundle carries its own
  // `@pierre/diffs`, and the repo it reviews has no dependencies to lend it.
  expect(existsSync(cli.bundle)).toBe(true);
  expect(existsSync(join(cli.root, "node_modules"))).toBe(false);
  expect(existsSync(join(repo.path, "node_modules"))).toBe(false);
}, 60_000);

afterAll(() => {
  rmSync(cli.root, { recursive: true, force: true });
  rmSync(repo.path, { recursive: true, force: true });
});

/** Every `rvw` call in this suite runs the bundle under Node from inside the foreign repo, so
 * `--repo .` is the repo being reviewed and the Reviewer checkout is never on the path. */
function run(...args: readonly string[]): RvwResult {
  return rvw(cli, repo, args);
}

function range(): string[] {
  return ["--repo", ".", "--base", repo.base, "--head", repo.head];
}

/** Both streams, for a failure message that shows whichever one carried the reason. */
function output(result: RvwResult): string {
  return `${result.stdout}${result.stderr}`;
}

/** Write a draft into the foreign repo (where an authoring agent would keep it) and return its
 * path. Named per-case so a refused draft cannot be confused with the one that emitted. */
function draftFile(name: string, draft: Draft): string {
  const path = join(repo.path, name);
  writeFileSync(path, JSON.stringify(draft, null, 2));
  return path;
}

function anchorsUniverse(): FileUniverse[] {
  const result = run("anchors", ...range(), "--json");
  expect(result.status, output(result)).toBe(0);
  return JSON.parse(result.stdout) as FileUniverse[];
}

function coverageOf(draftPath: string, ...flags: readonly string[]): RvwResult {
  return run("coverage", ...range(), "--draft", draftPath, ...flags);
}

/** Emit the complete walkthrough and assert the artifact reached disk — the step every later
 * assertion reads from, factored out so the loop test and the open-in-app test each drive the
 * real `rvw emit` rather than sharing one run's leftovers. */
function emitComplete(out: string): void {
  const result = run(
    "emit",
    ...range(),
    "--draft",
    draftFile("draft.complete.json", COMPLETE_DRAFT),
    "--out",
    out,
  );
  expect(result.status, output(result)).toBe(0);
  expect(existsSync(join(repo.path, out))).toBe(true);
}

function readArtifact(out: string): ReviewArtifact {
  return ReviewArtifact.parse(JSON.parse(readFileSync(join(repo.path, out), "utf8")));
}

/** True when the anchor lies inside a contiguous changed span the universe listed for its file
 * and side — i.e. the line number was read, not guessed. */
function withinUniverse(universe: readonly FileUniverse[], anchor: ReviewAnchor): boolean {
  const file = universe.find((candidate) => candidate.file === anchor.file);
  if (file === undefined || !file.coverable) {
    return false;
  }
  return file.spans.some(
    (span) =>
      span.side === anchor.side &&
      span.startLine <= anchor.startLine &&
      anchor.endLine <= span.endLine,
  );
}

/** Deterministic identity so `importReview` stays reproducible: the app assigns this on open
 * (crypto.randomUUID); the gate pins it. */
function stamp(): ReviewStamp {
  let n = 0;
  return { newId: () => `id-${(n += 1)}` };
}

const UI: CommentUiState = { editingId: null, draft: null };

/** Where the app's render path put a comment: `lineNumber` is the placed line (0 = pinned to the
 * file header) and `outdated` is the resolver verdict CodeView renders. */
type PlacedAnnotation = { lineNumber: number; outdated: boolean };

function annotationFor(
  items: ReturnType<typeof buildCommentItems>,
  file: string,
): PlacedAnnotation {
  const annotation = items.find((item) => item.id === file)?.annotations?.[0];
  if (annotation === undefined || annotation.metadata.kind !== "comment") {
    throw new Error(`no comment annotation for ${file}`);
  }
  return { lineNumber: annotation.lineNumber, outdated: annotation.metadata.outdated };
}

describe("exit gate: the agent's toolchain, end to end in a foreign repo", () => {
  it("authored anchors are read from the printed universe, not guessed", () => {
    const universe = anchorsUniverse();

    // The listing an agent reads: five changed files, the two unscoreable ones named as such.
    expect(universe.map((file) => file.file)).toEqual([
      "assets/logo.png",
      "docs/CHANGELOG.md",
      "src/engine.ts",
      "src/new-name.ts",
      "src/util.ts",
    ]);
    // `src/engine.ts` is the multi-hunk file: two changed regions, both sides, far apart. An
    // anchor authored off a single-hunk assumption would miss the second.
    expect(universe.find((file) => file.file === "src/engine.ts")).toEqual({
      file: "src/engine.ts",
      status: "modified",
      coverable: true,
      spans: [
        { side: "deletions", startLine: 2, endLine: 2 },
        { side: "deletions", startLine: 18, endLine: 18 },
        { side: "additions", startLine: 2, endLine: 2 },
        { side: "additions", startLine: 18, endLine: 18 },
      ],
    });

    // Every anchor of the walkthrough — comment and layer range alike — falls inside a span the
    // universe printed. This is what makes the fixture's line numbers evidence rather than
    // coincidence: change the diff and this fails before any coverage number does.
    const authored: ReviewAnchor[] = [
      ...COMPLETE_DRAFT.comments,
      ...COMPLETE_DRAFT.layers.flatMap((layer) => layer.ranges),
    ];
    for (const anchor of authored) {
      expect(withinUniverse(universe, anchor), `${anchor.file} ${anchor.side}`).toBe(true);
    }
    // And the guessed one does not — the universe would have told the agent so.
    expect(withinUniverse(universe, MIS_ANCHOR)).toBe(false);
  });

  it("reports the binary and the pure rename non-coverable, never as a gap to close", () => {
    const universe = anchorsUniverse();
    expect(universe.find((file) => file.file === "assets/logo.png")).toEqual({
      file: "assets/logo.png",
      status: "modified",
      coverable: false,
      reason: "binary",
    });
    expect(universe.find((file) => file.file === "src/new-name.ts")).toEqual({
      file: "src/new-name.ts",
      status: "renamed",
      coverable: false,
      reason: "pureRename",
    });

    // The honesty that matters is in the *coverage* report an agent acts on: both files appear,
    // both as `nonCoverable`, neither in the denominator and neither in the uncovered spans. A
    // tool that counted them would send the agent to write a layer over bytes it cannot anchor.
    const result = coverageOf(draftFile("draft.gap.json", GAP_DRAFT), "--json");
    expect(result.status, output(result)).toBe(0);
    const report = JSON.parse(result.stdout) as CoverageReport;

    expect(report.files).toContainEqual({
      file: "assets/logo.png",
      status: "nonCoverable",
      reason: "binary",
    });
    expect(report.files).toContainEqual({
      file: "src/new-name.ts",
      status: "nonCoverable",
      reason: "pureRename",
    });
    // Eight coverable changed lines: CHANGELOG 2, engine 4, util 2. Not ten — the two
    // non-coverable files contribute nothing to either side of the ratio.
    expect(report.headline.coverableChangedLines).toBe(8);
    for (const span of report.uncoveredSpans) {
      expect(span.file).not.toBe("assets/logo.png");
      expect(span.file).not.toBe("src/new-name.ts");
    }
  });

  it("runs the whole authoring loop: gap → layer → complete → emit → check", () => {
    const universe = anchorsUniverse();
    expect(universe.length).toBe(5);

    // 1. The draft that forgets `docs/CHANGELOG.md` — the file easy to leave out of every layer.
    // Coverage is advisory, so it exits 0: the gap is a fact reported with its exact locator, not
    // yet a verdict.
    const gap = draftFile("draft.gap.json", GAP_DRAFT);
    const advisory = coverageOf(gap);
    expect(advisory.status, output(advisory)).toBe(0);
    expect(advisory.stdout).toContain("uncovered      docs/CHANGELOG.md");
    expect(advisory.stdout).toContain("docs/CHANGELOG.md additions 2-3");
    expect(advisory.stdout).toContain("coverage 75% (6/8 changed lines)");

    // 2. The same gap under the opt-in gate is a refusal, with the same locator. This is the
    // negative the gate turns on: a review missing a whole changed file never reads ready.
    const gated = coverageOf(gap, "--require-complete");
    expect(gated.status, output(gated)).toBe(1);
    expect(gated.stdout).toContain("docs/CHANGELOG.md additions 2-3");
    const gapReport = JSON.parse(coverageOf(gap, "--json").stdout) as CoverageReport;
    expect(gapReport.uncoveredSpans).toEqual([
      { file: "docs/CHANGELOG.md", side: "additions", startLine: 2, endLine: 3 },
    ]);

    // 3. The agent adds the layer coverage asked for. Now every coverable changed line is in
    // some layer, and the gate that just refused passes on the same range and the same core.
    const complete = draftFile("draft.complete.json", COMPLETE_DRAFT);
    const closed = coverageOf(complete, "--require-complete");
    expect(closed.status, output(closed)).toBe(0);
    expect(closed.stdout).toContain("coverage 100% (8/8 changed lines)");

    // 4. Emit — the artifact is validated before a byte reaches disk — then the one composite
    // gate an agent runs before handing over: valid *and* complete.
    emitComplete(ARTIFACT);
    const checked = run("check", ARTIFACT, "--require-complete");
    expect(checked.status, output(checked)).toBe(0);
    expect(checked.stdout).toContain("valid — every anchor places, every link resolves");
    expect(checked.stdout).toContain("ready to hand over");

    // The artifact describes the *foreign* repo, not the checkout the CLI was built from.
    expect(readArtifact(ARTIFACT).source.repo.path).toBe(repo.path);
  });

  it("refuses a mis-anchored draft at emit — exit 1, exact locator, nothing written", () => {
    const misAnchored = draftFile("draft.mis-anchored.json", {
      comments: [{ ...MIS_ANCHOR, body: "a line number nobody read" }],
      layers: COMPLETE_DRAFT.layers,
    });
    const out = "mis-anchored.reviewer.json";

    const result = run("emit", ...range(), "--draft", misAnchored, "--out", out);
    expect(result.status, output(result)).toBe(1);
    expect(result.stderr).toContain("nothing written");
    expect(result.stderr).toContain(
      `comment anchor does not place in the diff: ${MIS_ANCHOR_LOCATOR}`,
    );
    // The load-bearing half of the contract: a refused artifact is not a bad file on disk, it is
    // no file at all. There is nothing for the agent to hand over by mistake.
    expect(existsSync(join(repo.path, out))).toBe(false);
  });

  it("catches a mis-anchor on the wire: validate and check both refuse with the locator", () => {
    // `emit` cannot produce this artifact, so it is hand-built from one that emitted clean —
    // the shape a tamper, a hand-edit, or a validator-bypassing tool produces. It stays refs-only,
    // `validate`/`check` re-derive the diff from its `source` (the foreign repo is present), and
    // the drifted anchor places nowhere in that re-derived diff.
    emitComplete(ARTIFACT);
    const artifact = readArtifact(ARTIFACT);
    const tampered: ReviewArtifact = {
      ...artifact,
      comments: artifact.comments.map((comment) =>
        comment.file === MIS_ANCHOR.file ? { ...comment, ...MIS_ANCHOR } : comment,
      ),
    };
    const path = "tampered.reviewer.json";
    writeFileSync(join(repo.path, path), JSON.stringify(tampered));

    const validated = run("validate", path);
    expect(validated.status, output(validated)).toBe(1);
    expect(validated.stderr).toContain(
      `comment anchor does not place in the diff: ${MIS_ANCHOR_LOCATOR}`,
    );

    // `check` composes the two severities: a mis-anchor is a hard failure, so it refuses at the
    // validate stage and reports no coverage — there is nothing sound left to measure. A gate
    // that printed "100% covered" beside a mis-anchor would be a false green wearing a number.
    const checked = run("check", path, "--json");
    expect(checked.status, output(checked)).toBe(1);
    const report = JSON.parse(checked.stdout) as CheckReport;
    expect(report.ok).toBe(false);
    expect(report.stage).toBe("validate");
    expect(report).not.toHaveProperty("coverage");
    expect(run("check", path).stdout).not.toContain("ready to hand over");
  });

  it("opens in Reviewer with zero manual fixing: every comment on its authored line", async () => {
    emitComplete(ARTIFACT);

    // The app's *own* open path, driven on the file the CLI just wrote. `reviewPathFromArgv` is
    // the argv → path step (`Reviewer walkthrough.reviewer.json`), and `importReviewFromPath` is
    // the one seam every open funnels through — argv, File→Open, drag-drop alike.
    // Both are Electron-free, so the gate exercises the real thing rather than a stand-in: what
    // is left unproven here is the window's pixels, not the app's acceptance of the artifact.
    const path = reviewPathFromArgv(["electron", ".", ARTIFACT], repo.path);
    expect(path).toBe(join(repo.path, ARTIFACT));
    if (path === null) return;

    const opened = await importReviewFromPath(path, stamp());
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const review = opened.review;

    // The artifact is refs-only: it carries no patch, so the app re-derives base...head
    // from git on open and anchors resolve positionally against that live diff. Resolve the same
    // diff through the CLI's own `artifactDiff` (the foreign repo is present) to render against.
    const diff = reviewDiffFor(review);
    expect(diff.kind).toBe("refs");
    expect(review.patch).toBeNull();

    const captured = artifactDiff(readArtifact(ARTIFACT));
    if (!captured.ok) throw new Error(captured.message);
    const files = parsePatch(captured.patch, "m6-exit-gate");

    // Derived mode is the mode the app renders a refs-only artifact in, and the mode that can
    // *fail*: it resolves each anchor against the re-derived diff's hunks. Every comment lands on
    // its authored line, none outdated — nothing for a human to fix on open.
    const derived = buildCommentItems(files, review.comments, UI, false);
    expect(annotationFor(derived, "src/engine.ts")).toEqual({ lineNumber: 2, outdated: false });
    expect(annotationFor(derived, "src/util.ts")).toEqual({ lineNumber: 2, outdated: false });

    // Layer order is reading order — the app re-sorts nothing, so the walkthrough steps
    // in the sequence the agent authored, changelog last because coverage put it there.
    expect(review.layers.map((layer) => layer.id)).toEqual(["engine", "util", "changelog"]);
  });
});
