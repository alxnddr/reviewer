import type { AnchorSpan } from "../review";
import type { PatchFile } from "./patch";
import { walkFileLines } from "./walk";

// Moved code, found positionally: a run of deleted lines that reappears — verbatim once
// whitespace is normalized — as a run of added lines somewhere else in the same diff. What
// this module produces is a *fact* ("these 8 lines came from src/old.ts:3-10"), and
// deliberately nothing else. It does not hide, fold, re-colour or re-order a single line.
//
// Two reasons the fact is kept separate from the render, and both are load-bearing:
//
//   - `@pierre/diffs` has no public per-line or sub-line decoration API (its issue #884), so
//     the blue/purple tint Cursor's team-kit draws is not available to this app, and
//     reimplementing the render is out (CLAUDE.md: highlighting and the worker pool are the
//     library's). The shape that *is* available is an annotation beneath the block's first
//     line, which `comment-annotations.ts` already established as the only sanctioned way to
//     add to Pierre's surface.
//   - A moved block's lines must stay ordinary additions and deletions to everything else.
//     Anchoring, coverage and the read tally walk the same `walkFileLines` they always did
//     and never learn this pass ran. That is what stops a detector's *opinion* from changing
//     the diff the gate checked — the failure Cursor's team-kit variant has, where hiding
//     import-only lines and collapsing whitespace-only changes makes the reader's diff and
//     the checked diff two different documents.
//
// The pass is positional, not semantic: it knows nothing about syntax, so it works in any
// language and can never disagree with a parse.
//
// ## The thresholds, and why they are these
//
// Cursor's team-kit numbers are the starting point (runs of ≥3 lines, whitespace-normalized,
// a match at ≥3 lines and ≥70% of the shorter block, and a 40). Three are copied; the fourth
// was moved on purpose, which is written out below.
//
//   - `MIN_MOVE_LINES = 3` — the shortest run that can be a move, and the shortest match that
//     can be reported. Two lines of `});` and a blank match everywhere, so a two-line minimum
//     reports the shape of the language rather than the shape of the refactor.
//   - `MIN_COVERAGE_PERCENT = 70` — a match must cover at least 70% of the *shorter* of the
//     two runs it sits in. This is what separates "this block moved" from "these two rewrites
//     happen to share a preamble": three shared lines between an 11-line deletion and an
//     11-line addition is 27% and is not a move; the same three lines between two 3-line runs
//     are the whole of both and are.
//   - `MAX_SEED_OCCURRENCES = 40` — a line whose normalized text occurs more than 40 times on
//     the additions side starts nothing. This is where Cursor's 40 went, and moving it there
//     was deliberate rather than a mis-copy: capping a matched *block* at 40 lines would
//     truncate the 200-line refactor this feature exists for, while capping the candidates one
//     line offers is what actually bounds the cost (below). An over-common line still matches
//     *inside* a block; it just cannot be the line a search starts from.
//   - `MIN_SEED_LENGTH = 4` — nor does a normalized line shorter than this: `}`, `)`, `],` and
//     the empty line are the bulk of any diff and carry no identity. Together with the rule
//     above, every reported block contains at least one line that is neither blank nor
//     punctuation, which is the property that makes the annotation worth reading at all.
//
// ## The cost, measured rather than assumed
//
// One walk to collect the runs, one pass to index the additions, then one seeded extension
// per unconsumed deletion line. Both consumption maps put a line in at most one block, so a
// match at line d costs its own length and then skips over it; a *failed* seed costs at most
// `MAX_SEED_OCCURRENCES` comparisons plus however far each candidate happened to agree.
// Measured rather than reasoned about, twice. On the worst realistic shape —
// `buildMovedLinesPatch(400, 60)`, 400 files whose 24,000 added lines are every one of them a
// move of the 24,000 lines deleted beside them, an order of magnitude past any review this app
// opens — ~40 ms. On this repository's own `HEAD~8..HEAD` (96 files, 440 KB of patch), ~7 ms,
// and it finds three real moves, including the schema body that `editor-ipc.ts` re-indented
// into a union arm. `moved.test.ts` runs the synthetic one and leaves vitest's default 5 s
// timeout as the regression guard, since asserting a millisecond count would be asserting the
// CI machine.

/** The shortest run, and the shortest match, that can be a move. */
const MIN_MOVE_LINES = 3;
/** How much of the shorter of the two runs a match must cover, in percent. Compared as
 * integers (`length * 100 >= shorter * 70`) rather than against `shorter * 0.7`, because the
 * float form is wrong for real inputs: `0.7 * 30` is `21.000000000000004`, which would reject
 * a 21-line match of a 30-line run — exactly 70%. */
const MIN_COVERAGE_PERCENT = 70;
/** Past this many occurrences on the additions side, a line identifies nothing and seeds
 * nothing. The cost bound. */
const MAX_SEED_OCCURRENCES = 40;
/** Shorter than this, normalized, a line seeds nothing either. */
const MIN_SEED_LENGTH = 4;

/** One moved block: the lines where they were deleted, and the same lines where they were
 * added. Both endpoints are `AnchorSpan`s — file, side, inclusive line range — so the render
 * half can navigate to one through exactly the machinery a comment anchor and a prose
 * reference already go through, instead of a fourth private way to say "this range of that
 * file". `from.side` is always `"deletions"` and `to.side` always `"additions"`; they are
 * spelled out rather than implied so the value is usable as an anchor unchanged. */
export type MovedBlock = {
  from: AnchorSpan;
  to: AnchorSpan;
  /** Matched line count — the same on both sides, since a match is line-for-line. */
  lines: number;
};

/** One maximal run of consecutive changed lines on one side of one file: the unit a match's
 * coverage is measured against. A context line ends a run, so a single edited line inside a
 * moved block splits it in two — two shorter annotations, or none, rather than one that
 * claims lines the reader can see are different. */
type Run = {
  /** The file's identity within the diff (`PatchFile.path`), which is what an anchor names —
   * including for the deletions side of a rename, where it is the *new* path and
   * `filesByAnchorPath` resolves it. */
  path: string;
  /** 1-based line number, in this side's coordinates, of the line at `start`. */
  startLine: number;
  /** Index into the side's `texts` of this run's first line. */
  start: number;
  length: number;
};

/** Every changed line of one side, normalized, its runs concatenated. Flat because extension
 * walks line by line and has to stop at a run boundary on every step; an array of arrays would
 * spend the inner loop re-deriving which run it was in. `runOf` is parallel to `texts`. */
type Side = {
  texts: string[];
  runOf: Run[];
};

/** A seed pair grown as far as it goes, before the thresholds have judged it. */
type Match = {
  dStart: number;
  aStart: number;
  length: number;
  dRun: Run;
  aRun: Run;
};

const EOL = /\r?\n$/u;
const WHITESPACE_RUN = /\s+/gu;

/** A line reduced to what a move preserves: no line terminator, no leading or trailing
 * whitespace, and every internal whitespace run flattened to one space. Re-indenting a block
 * as it moves into a deeper scope is the common case, not the exception, so a comparison that
 * saw indentation would miss most real moves. */
function normalize(text: string): string {
  return text.replace(EOL, "").trim().replace(WHITESPACE_RUN, " ");
}

/** Every run of `kind` lines across the diff, in file order then line order. Runs shorter than
 * `MIN_MOVE_LINES` are dropped here rather than filtered later: they can neither host nor
 * complete a match, and dropping them keeps them out of the seed index too. */
function collectSide(files: readonly PatchFile[], kind: "addition" | "deletion"): Side {
  const side: Side = { texts: [], runOf: [] };
  for (const file of files) {
    const lines = kind === "addition" ? file.fileDiff.additionLines : file.fileDiff.deletionLines;
    let pending: string[] = [];
    let pendingStart = 0;
    const flush = (): void => {
      if (pending.length >= MIN_MOVE_LINES) {
        const run: Run = {
          path: file.path,
          startLine: pendingStart,
          start: side.texts.length,
          length: pending.length,
        };
        for (const text of pending) {
          side.texts.push(text);
          side.runOf.push(run);
        }
      }
      pending = [];
    };
    walkFileLines(file.fileDiff, (line) => {
      if (line.kind !== kind) {
        return;
      }
      // A gap in the numbering is a context block or a hunk boundary between the two lines.
      if (pending.length > 0 && line.lineNumber !== pendingStart + pending.length) {
        flush();
      }
      if (pending.length === 0) {
        pendingStart = line.lineNumber;
      }
      pending.push(normalize(lines[line.index] ?? ""));
    });
    flush();
  }
  return side;
}

/** Normalized addition text → the indices carrying it. A bucket is allowed to reach
 * `MAX_SEED_OCCURRENCES + 1` entries and no further: that one extra entry is how the lookup
 * tells "40 candidates" from "too common to mean anything" without counting the rest of the
 * diff. */
function seedIndex(side: Side): Map<string, number[]> {
  const index = new Map<string, number[]>();
  for (const [position, text] of side.texts.entries()) {
    if (text.length < MIN_SEED_LENGTH) {
      continue;
    }
    const bucket = index.get(text);
    if (bucket === undefined) {
      index.set(text, [position]);
    } else if (bucket.length <= MAX_SEED_OCCURRENCES) {
      bucket.push(position);
    }
  }
  return index;
}

/** The longest run of equal lines through one seed pair, bounded by each side's run and by
 * lines an earlier block already took. It grows *backwards* as well as forwards because a
 * block's opening lines are so often blank or a lone brace, which never seed — the search has
 * to be able to start in the middle of the thing it is looking for. */
function extendMatch(
  deletions: Side,
  additions: Side,
  seed: { deletion: number; addition: number },
  dRun: Run,
  aRun: Run,
  usedDeletion: Uint8Array,
  usedAddition: Uint8Array,
): Match {
  const agrees = (d: number, a: number): boolean =>
    d >= dRun.start &&
    d < dRun.start + dRun.length &&
    a >= aRun.start &&
    a < aRun.start + aRun.length &&
    usedDeletion[d] === 0 &&
    usedAddition[a] === 0 &&
    deletions.texts[d] === additions.texts[a];
  let back = 0;
  while (agrees(seed.deletion - back - 1, seed.addition - back - 1)) {
    back += 1;
  }
  let forward = 0;
  while (agrees(seed.deletion + forward + 1, seed.addition + forward + 1)) {
    forward += 1;
  }
  return {
    dStart: seed.deletion - back,
    aStart: seed.addition - back,
    length: back + forward + 1,
    dRun,
    aRun,
  };
}

/** Whether a match is a move rather than a coincidence: long enough in absolute terms, and
 * enough of the shorter run that it is what that run is *about*. */
function isMove(match: Match): boolean {
  const shorter = Math.min(match.dRun.length, match.aRun.length);
  return match.length >= MIN_MOVE_LINES && match.length * 100 >= shorter * MIN_COVERAGE_PERCENT;
}

/** Whether the two ends are really the same place: same file, and line ranges that overlap.
 * This is how an in-place reformat is kept out — re-indenting three lines makes them a
 * perfect "move" from `x.ts:2-4` to `x.ts:2-4`, which is a true statement and a useless one.
 * The comparison is approximate on purpose (the two ends are in different coordinate systems,
 * old-file and new-file), and approximate is right: what it removes is the reformat and the
 * block that shifted by a line or two, which are exactly the changes nobody calls a move. */
function isInPlace(from: AnchorSpan, to: AnchorSpan): boolean {
  return from.file === to.file && from.startLine <= to.endLine && to.startLine <= from.endLine;
}

function spanOf(run: Run, side: AnchorSpan["side"], start: number, length: number): AnchorSpan {
  const first = run.startLine + (start - run.start);
  return { file: run.path, side, startLine: first, endLine: first + length - 1 };
}

/** Every block of ≥3 lines that was deleted in one place and added in another, ordered the
 * way the diff reads at the destination: file order, then line. Each line of the diff belongs
 * to at most one block — the first match that claims it wins, which is why the loop runs in
 * deletion order and marks as it goes.
 *
 * Costs nothing on a diff with no deletion runs or no addition runs at all (a review that only
 * adds files is the common one), because `collectSide` has already dropped every run too short
 * to matter and there is then nothing to index. */
export function detectMovedBlocks(files: readonly PatchFile[]): MovedBlock[] {
  const deletions = collectSide(files, "deletion");
  const additions = collectSide(files, "addition");
  if (deletions.texts.length === 0 || additions.texts.length === 0) {
    return [];
  }
  const index = seedIndex(additions);
  const usedDeletion = new Uint8Array(deletions.texts.length);
  const usedAddition = new Uint8Array(additions.texts.length);
  const matches: Match[] = [];
  for (const [d, text] of deletions.texts.entries()) {
    if (usedDeletion[d] === 1 || text.length < MIN_SEED_LENGTH) {
      continue;
    }
    const bucket = index.get(text);
    const dRun = deletions.runOf[d];
    if (bucket === undefined || bucket.length > MAX_SEED_OCCURRENCES || dRun === undefined) {
      continue;
    }
    let best: Match | null = null;
    for (const a of bucket) {
      const aRun = additions.runOf[a];
      if (usedAddition[a] === 1 || aRun === undefined) {
        continue;
      }
      const match = extendMatch(
        deletions,
        additions,
        { deletion: d, addition: a },
        dRun,
        aRun,
        usedDeletion,
        usedAddition,
      );
      if (best === null || match.length > best.length) {
        best = match;
      }
    }
    if (best === null || !isMove(best)) {
      continue;
    }
    // Claimed whether or not the in-place test below throws the block away: a re-indent that
    // matched itself must not then be offered to some other run as a move.
    usedDeletion.fill(1, best.dStart, best.dStart + best.length);
    usedAddition.fill(1, best.aStart, best.aStart + best.length);
    matches.push(best);
  }
  return (
    matches
      // `aStart` indexes a list built in file order and then line order, so ordering on it
      // alone is ordering the way the destination reads — no file lookup, no second key.
      .toSorted((left, right) => left.aStart - right.aStart)
      .map((match) => ({
        from: spanOf(match.dRun, "deletions", match.dStart, match.length),
        to: spanOf(match.aRun, "additions", match.aStart, match.length),
        lines: match.length,
      }))
      .filter((block) => !isInPlace(block.from, block.to))
  );
}
