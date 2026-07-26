import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  reviewDiffFor,
  ReviewArtifact,
  type ReviewAnchor,
  type ReviewComment,
  type ReviewLayerDraft,
  type ReviewStamp,
} from "../src/shared/review";
import { importReviewFromPath, reviewPathFromArgv } from "../src/main/review/guard";
import { parsePatch } from "../src/renderer/src/lib/diff/patch";
import {
  buildCommentItems,
  type CommentUiState,
} from "../src/renderer/src/lib/diff/comment-annotations";
import type { FileUniverse } from "../src/tools/review-coverage";
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
// distributed `rvw` bundle, presents a **complete** and **valid** review of a repo that is not
// the Reviewer checkout, and it opens with zero manual fixing.
//
// So every command below is spawned as `node dist/rvw.js` with the foreign repo as cwd — the
// bundle boundary and the repo boundary are both real, and the draft goes in on the child's
// stdin, which is the only way that path exists at all. Nothing is mocked, and nothing
// short-circuits into the in-process cores except the final step, which is the *app's* own open
// and render path reading the bytes the CLI actually wrote.
//
// A green happy path is not a passed gate, so the two negatives are asserted with the same
// force as the positive: a draft that forgets a changed file is caught by `check
// --require-complete` with the exact uncovered file (exit 1), and a mis-anchored draft is
// caught before any bytes reach disk (`emit`, exit 1) and again on the wire (`check`, exit 1)
// with the exact locator. Neither ever reads ready. And the two files a machine cannot score —
// a binary and a pure rename — are reported non-coverable, never handed to the agent as work.

const ARTIFACT = "walkthrough.reviewer.json";

// The walkthrough the agent authors, in reading order (the app re-sorts nothing). Its
// anchors are not invented here — `authored anchors are read from the printed universe` proves
// every one of them falls inside a span `rvw diff --json` listed for this range.
const ENGINE_LAYER: ReviewLayerDraft = {
  label: "Engine",
  summary: "Two entry points rewritten, far apart in the file",
  description: "Rewrites the [engine](src/engine.ts) entry points.",
  ranges: [
    { file: "src/engine.ts", side: "deletions", startLine: 2, endLine: 2 },
    { file: "src/engine.ts", side: "deletions", startLine: 18, endLine: 18 },
    { file: "src/engine.ts", side: "additions", startLine: 2, endLine: 2 },
    { file: "src/engine.ts", side: "additions", startLine: 18, endLine: 18 },
  ],
};
const UTIL_LAYER: ReviewLayerDraft = {
  label: "Util",
  summary: "The helper the engine leans on follows suit",
  ranges: [
    { file: "src/util.ts", side: "deletions", startLine: 2, endLine: 2 },
    { file: "src/util.ts", side: "additions", startLine: 2, endLine: 2 },
  ],
};
/** The layer the agent adds *because coverage told it to* — the one file a walkthrough forgets. */
const CHANGELOG_LAYER: ReviewLayerDraft = {
  label: "Changelog",
  summary: "The change is announced",
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
 * hunk of it covers line 900. Both deny-paths (`emit`'s pre-write gate and `check`'s
 * on-the-wire check) must name exactly this locator. */
const MIS_ANCHOR: ReviewAnchor = {
  file: "src/engine.ts",
  side: "additions",
  startLine: 900,
  endLine: 901,
};
const MIS_ANCHOR_LOCATOR = "src/engine.ts additions 900-901";

/** The draft an agent hands `rvw`: only what it authored. The range and its patch are the
 * CLI's to work out and capture. */
type Draft = {
  comments?: ReviewComment[] | undefined;
  layers?: ReviewLayerDraft[] | undefined;
};

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
 * the defaulted `--repo` is the repo being reviewed and the Reviewer checkout is never on the
 * path. */
function run(...args: readonly string[]): RvwResult {
  return rvw(cli, repo, args);
}

function range(): string[] {
  return ["--base", repo.base, "--head", repo.head];
}

/** Both streams, for a failure message that shows whichever one carried the reason. */
function output(result: RvwResult): string {
  return `${result.stdout}${result.stderr}`;
}

/** `rvw emit` the way an agent runs it: the draft on stdin, no temp file in the repo it is
 * reviewing. `--no-open` because the assertion is about the artifact, not the window; the
 * default-on launch is proven in `emit.test.ts` on a platform with no app to launch. */
function emit(draft: Draft, ...args: readonly string[]): RvwResult {
  return rvw(cli, repo, ["emit", ...range(), "--no-open", ...args], JSON.stringify(draft, null, 2));
}

function universe(): FileUniverse[] {
  const result = run("diff", ...range(), "--json");
  expect(result.status, output(result)).toBe(0);
  return JSON.parse(result.stdout) as FileUniverse[];
}

/** Emit the complete walkthrough and assert the artifact reached disk — the step every later
 * assertion reads from, factored out so the loop test and the open-in-app test each drive the
 * real `rvw emit` rather than sharing one run's leftovers. */
function emitComplete(out: string): void {
  const result = emit(COMPLETE_DRAFT, "--out", out);
  expect(result.status, output(result)).toBe(0);
  expect(existsSync(join(repo.path, out))).toBe(true);
}

function readArtifact(out: string): ReviewArtifact {
  return ReviewArtifact.parse(JSON.parse(readFileSync(join(repo.path, out), "utf8")));
}

/** True when the anchor lies inside a contiguous changed span the universe listed for its file
 * and side — i.e. the line number was read, not guessed. */
function withinUniverse(files: readonly FileUniverse[], anchor: ReviewAnchor): boolean {
  const file = files.find((candidate) => candidate.file === anchor.file);
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
    const files = universe();

    // The listing an agent reads: five changed files, the two unscoreable ones named as such.
    expect(files.map((file) => file.file)).toEqual([
      "assets/logo.png",
      "docs/CHANGELOG.md",
      "src/engine.ts",
      "src/new-name.ts",
      "src/util.ts",
    ]);
    // `src/engine.ts` is the multi-hunk file: two changed regions, both sides, far apart. An
    // anchor authored off a single-hunk assumption would miss the second.
    expect(files.find((file) => file.file === "src/engine.ts")).toEqual({
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
      ...COMMENTS,
      ...(COMPLETE_DRAFT.layers ?? []).flatMap((layer) => layer.ranges ?? []),
    ];
    for (const anchor of authored) {
      expect(withinUniverse(files, anchor), `${anchor.file} ${anchor.side}`).toBe(true);
    }
    // And the guessed one does not — the universe would have told the agent so.
    expect(withinUniverse(files, MIS_ANCHOR)).toBe(false);
  });

  it("prints the same diff the gate judges against, so nothing has to be reproduced by hand", () => {
    // The reason `rvw diff` exists: the authoring instructions used to hand the agent a git
    // incantation to run itself, and any drift from the CLI's own capture would mean anchors
    // authored against different path bytes. One capture, one output.
    const printed = run("diff", ...range());
    expect(printed.status, output(printed)).toBe(0);

    emitComplete(ARTIFACT);
    const gated = artifactDiff(readArtifact(ARTIFACT));
    if (!gated.ok) throw new Error(gated.message);
    expect(printed.stdout).toBe(gated.patch);
  });

  it("reports the binary and the pure rename non-coverable, never as a gap to close", () => {
    const files = universe();
    expect(files.find((file) => file.file === "assets/logo.png")).toEqual({
      file: "assets/logo.png",
      status: "modified",
      coverable: false,
      reason: "binary",
    });
    expect(files.find((file) => file.file === "src/new-name.ts")).toEqual({
      file: "src/new-name.ts",
      status: "renamed",
      coverable: false,
      reason: "pureRename",
    });

    // The honesty that matters is in the *coverage* report an agent acts on: both files appear,
    // both as `nonCoverable`, neither in the denominator and neither in the uncovered spans. A
    // tool that counted them would send the agent to write a layer over bytes it cannot anchor.
    const out = "gap.reviewer.json";
    expect(emit(GAP_DRAFT, "--out", out).status).toBe(0);
    const scored = run("check", out, "--coverage", "--json");
    expect(scored.status, output(scored)).toBe(0);
    const report = JSON.parse(scored.stdout) as Extract<CheckReport, { stage: "coverage" }>;

    expect(report.coverage.files).toContainEqual({
      file: "assets/logo.png",
      status: "nonCoverable",
      reason: "binary",
    });
    expect(report.coverage.files).toContainEqual({
      file: "src/new-name.ts",
      status: "nonCoverable",
      reason: "pureRename",
    });
    // Eight coverable changed lines: CHANGELOG 2, engine 4, util 2. Not ten — the two
    // non-coverable files contribute nothing to either side of the ratio.
    expect(report.coverage.headline.coverableChangedLines).toBe(8);
    for (const span of report.coverage.uncoveredSpans) {
      expect(span.file).not.toBe("assets/logo.png");
      expect(span.file).not.toBe("src/new-name.ts");
    }
  });

  it("runs the whole authoring loop: draft on stdin → gap → layer → complete → ready", () => {
    const files = universe();
    expect(files.length).toBe(5);

    // 1. The draft that forgets `docs/CHANGELOG.md` — the file easy to leave out of every
    // layer. It is a perfectly valid review, so it emits, and the artifact is real.
    const gapOut = "loop.gap.reviewer.json";
    const emitted = emit(GAP_DRAFT, "--out", gapOut);
    expect(emitted.status, output(emitted)).toBe(0);
    expect(existsSync(join(repo.path, gapOut))).toBe(true);

    // 2. Coverage is advisory, so asking for it exits 0: the gap is a fact reported with its
    // file, not yet a verdict — and the flattened spans stay out of the text channel.
    const advisory = run("check", gapOut, "--coverage");
    expect(advisory.status, output(advisory)).toBe(0);
    expect(advisory.stdout).toContain("uncovered      docs/CHANGELOG.md");
    expect(advisory.stdout).toContain("coverage 75% (6/8 changed lines)");
    expect(advisory.stdout).not.toContain("uncovered spans:");
    expect(advisory.stderr).toContain("warning: a coverable changed line is in no layer");

    // 3. The same gap under the opt-in gate is a refusal, with the same locator in --json. This
    // is the negative the gate turns on: a review missing a whole changed file never reads ready.
    const gated = run("check", gapOut, "--require-complete");
    expect(gated.status, output(gated)).toBe(1);
    expect(gated.stdout).toContain("uncovered      docs/CHANGELOG.md");
    expect(gated.stdout).not.toContain("ready to hand over");
    const gapReport = JSON.parse(run("check", gapOut, "--coverage", "--json").stdout) as Extract<
      CheckReport,
      { stage: "coverage" }
    >;
    expect(gapReport.coverage.uncoveredSpans).toEqual([
      { file: "docs/CHANGELOG.md", side: "additions", startLine: 2, endLine: 3 },
    ]);

    // 4. The agent adds the layer coverage asked for and re-emits. Now every coverable changed
    // line is in some layer, and the gate that just refused passes on the same range and core.
    emitComplete(ARTIFACT);
    const checked = run("check", ARTIFACT, "--require-complete");
    expect(checked.status, output(checked)).toBe(0);
    expect(checked.stdout).toContain("valid — every anchor places, every link resolves");
    expect(checked.stdout).toContain("coverage 100% (8/8 changed lines)");
    expect(checked.stdout).toContain("ready to hand over");

    // The artifact describes the *foreign* repo, not the checkout the CLI was built from, and
    // carries the range that was asked for rather than a ref that would re-derive elsewhere.
    expect(readArtifact(ARTIFACT)).toMatchObject({
      repo: repo.path,
      base: repo.base,
      head: repo.head,
    });
  });

  it("presents a comments-only review — layers are the product, not the price of entry", () => {
    // An agent arriving with findings from its own review command and no walkthrough must be
    // able to show them. It used to be refused outright: `layers` was a required array.
    const out = "comments-only.reviewer.json";
    const emitted = emit({ comments: COMMENTS }, "--out", out);
    expect(emitted.status, output(emitted)).toBe(0);
    expect(readArtifact(out).layers).toEqual([]);

    // And it is not nagged about coverage it never claimed: a review with no layers has no
    // coverage story to be incomplete about.
    const checked = run("check", out, "--coverage");
    expect(checked.status, output(checked)).toBe(0);
    expect(checked.stderr).toBe("");
  });

  it("works out the range when the agent names none of it", () => {
    // The target invocation: the agent is standing in the repo it reviewed, so it types the
    // review and nothing else. The fixture's head is the checked-out branch's tip.
    const out = "defaulted.reviewer.json";
    const emitted = rvw(
      cli,
      repo,
      ["emit", "--base", repo.base, "--no-open", "--out", out, "--json"],
      JSON.stringify(COMPLETE_DRAFT),
    );
    expect(emitted.status, output(emitted)).toBe(0);
    expect(JSON.parse(emitted.stdout)).toMatchObject({
      ok: true,
      repo: repo.path,
      base: repo.base,
      head: "main",
      opened: false,
    });
    // A branch head is stored as a branch, so the app re-derives it live; the artifact still
    // opens against exactly the diff the gate validated.
    expect(readArtifact(out).head).toBe("main");
  });

  it("refuses a mis-anchored draft at emit — exit 1, exact locator, nothing written", () => {
    const out = "mis-anchored.reviewer.json";
    const result = emit(
      {
        comments: [{ ...MIS_ANCHOR, body: "a line number nobody read" }],
        layers: COMPLETE_DRAFT.layers,
      },
      "--out",
      out,
    );
    expect(result.status, output(result)).toBe(1);
    expect(result.stderr).toContain("nothing written");
    expect(result.stderr).toContain(
      `comment anchor does not place in the diff: ${MIS_ANCHOR_LOCATOR}`,
    );
    // The refusal names the draft it was handed, not a file that never existed.
    expect(result.stderr).toContain("draft stdin refused");
    expect(result.stderr).not.toContain(out);
    // The load-bearing half of the contract: a refused artifact is not a bad file on disk, it is
    // no file at all. There is nothing for the agent to hand over by mistake.
    expect(existsSync(join(repo.path, out))).toBe(false);
  });

  it("refuses a draft that presents nothing, and says so as a code under --json", () => {
    const result = rvw(cli, repo, ["emit", ...range(), "--no-open", "--json"], "{}");
    expect(result.status, output(result)).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { code: "draftEmpty" },
    });
    expect(result.stderr).toBe("");
  });

  it("catches a mis-anchor on the wire: check refuses with the locator and scores nothing", () => {
    // `emit` cannot produce this artifact, so it is hand-built from one that emitted clean —
    // the shape a tamper, a hand-edit, or a validator-bypassing tool produces. It stays
    // refs-only, `check` re-derives the diff from its recorded repo/refs (the foreign repo is
    // present), and the drifted anchor places nowhere in that re-derived diff.
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

    const checked = run("check", path);
    expect(checked.status, output(checked)).toBe(1);
    expect(checked.stderr).toContain(
      `comment anchor does not place in the diff: ${MIS_ANCHOR_LOCATOR}`,
    );

    // `check` composes the two severities: a mis-anchor is a hard failure, so it refuses at the
    // validate stage and reports no coverage — there is nothing sound left to measure. A gate
    // that printed "100% covered" beside a mis-anchor would be a false green wearing a number.
    const asJson = run("check", path, "--coverage", "--json");
    expect(asJson.status, output(asJson)).toBe(1);
    const report = JSON.parse(asJson.stdout) as CheckReport;
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
    expect(review.layers.map((layer) => layer.label)).toEqual(["Engine", "Util", "Changelog"]);
  });
});
