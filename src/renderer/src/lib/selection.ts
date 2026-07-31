import { assertNever } from "../../../shared/assert";
import { clamp } from "../../../shared/clamp";
import { countLabel } from "../../../shared/plural";
import type { CommitSelection, CommitSha, LogEntry } from "../../../shared/git";
import { shortSha as abbreviate } from "./refs";

/** Inclusive index pair into the newest-first log list. `anchor` is where the brush
 * started and stays put; `focus` is the end the user moves (drag, shift-click,
 * shift-arrows). The selected range is always [min, max] of the two, so contiguity
 * holds by construction. Plain JSON on purpose — persisted as-is. */
export type BrushRange = { anchor: number; focus: number };

export type BrushAction =
  | { type: "set"; index: number }
  | { type: "extend"; index: number }
  | { type: "step"; direction: 1 | -1; extend: boolean };

function clampIndex(index: number, entryCount: number): number {
  return clamp(index, 0, entryCount - 1);
}

/** The range that came in, when the action did not actually move it. The store asks "did the
 * brush change?" by reference twice over — `previewBrush` against this result, then
 * `applyBrush` against the slice it wrote — and a freshly allocated but equal range defeats
 * both: a drag's 60 Hz of extends, or a held arrow at either end of the list, would each
 * reallocate the whole session record for a brush that stayed exactly where it was. */
function settled(range: BrushRange | null, next: BrushRange): BrushRange {
  return range !== null && range.anchor === next.anchor && range.focus === next.focus
    ? range
    : next;
}

/** Every brush interaction funnels through here; the result is null only when
 * there is nothing to select, never an out-of-bounds or non-contiguous range. */
export function brushReducer(
  range: BrushRange | null,
  action: BrushAction,
  entryCount: number,
): BrushRange | null {
  if (entryCount <= 0) {
    return null;
  }
  switch (action.type) {
    case "set": {
      const index = clampIndex(action.index, entryCount);
      return settled(range, { anchor: index, focus: index });
    }
    case "extend": {
      const focus = clampIndex(action.index, entryCount);
      if (range === null) {
        return { anchor: focus, focus };
      }
      return settled(range, { anchor: clampIndex(range.anchor, entryCount), focus });
    }
    case "step": {
      if (range === null) {
        return { anchor: 0, focus: 0 };
      }
      const focus = clampIndex(range.focus + action.direction, entryCount);
      return settled(
        range,
        action.extend
          ? { anchor: clampIndex(range.anchor, entryCount), focus }
          : { anchor: focus, focus },
      );
    }
  }
}

/** The normalized brush band: `top` ≤ `bottom`, direction-agnostic. */
export type BrushBounds = { top: number; bottom: number };

export function brushBounds(range: BrushRange): BrushBounds {
  return {
    top: Math.min(range.anchor, range.focus),
    bottom: Math.max(range.anchor, range.focus),
  };
}

export function brushContains(range: BrushRange, index: number): boolean {
  const { top, bottom } = brushBounds(range);
  return index >= top && index <= bottom;
}

/** Maps a brushed range over the newest-first log to the commit arms of the
 * selection union (a brush can never mean branch-vs-branch). The uncommitted
 * pseudo-entry is pinned to index 0 (shared/git.ts), so a range containing it
 * either is it alone or extends down into commits. Null means the range does not
 * fit the list — a stale brush after the log changed. */
export function selectionFromBrush(
  entries: readonly LogEntry[],
  range: BrushRange,
): CommitSelection | null {
  const { top, bottom } = brushBounds(range);
  if (top < 0 || bottom >= entries.length) {
    return null;
  }
  const newest = entries[top];
  const oldest = entries[bottom];
  if (newest === undefined || oldest === undefined) {
    return null;
  }
  if (newest.kind === "uncommitted") {
    if (oldest.kind === "uncommitted") {
      return { kind: "uncommitted" };
    }
    return { kind: "commitRangeWithUncommitted", first: oldest.commit.sha };
  }
  if (oldest.kind === "uncommitted") {
    // Unreachable while the pseudo-entry stays pinned on top; a stale brush over
    // a reshuffled list must not fabricate a range.
    return null;
  }
  return { kind: "commitRange", first: oldest.commit.sha, last: newest.commit.sha };
}

function indexOfSha(entries: readonly LogEntry[], sha: CommitSha): number | null {
  const index = entries.findIndex((entry) => entry.kind === "commit" && entry.commit.sha === sha);
  return index === -1 ? null : index;
}

/** `selectionFromBrush` inverted, for restoring a persisted session: re-locates a
 * SHA-anchored selection in the fresh log. Null when it no longer fits — a SHA
 * missing from the log (rewritten history, or beyond the 2000-commit window), a
 * working tree that is no longer dirty, or an inverted commit order —
 * so a stale selection degrades to nothing, never to a wrong-range brush. */
export function brushFromSelection(
  entries: readonly LogEntry[],
  selection: CommitSelection,
): BrushRange | null {
  switch (selection.kind) {
    case "uncommitted":
      return entries[0]?.kind === "uncommitted" ? { anchor: 0, focus: 0 } : null;
    case "commitRangeWithUncommitted": {
      if (entries[0]?.kind !== "uncommitted") {
        return null;
      }
      const first = indexOfSha(entries, selection.first);
      return first === null ? null : { anchor: 0, focus: first };
    }
    case "commitRange": {
      const newest = indexOfSha(entries, selection.last);
      const oldest = indexOfSha(entries, selection.first);
      if (newest === null || oldest === null || newest > oldest) {
        return null;
      }
      return { anchor: newest, focus: oldest };
    }
    default:
      return assertNever(selection);
  }
}

/** The brush covering every row — the whole review range, which reads as "the full
 * review" rather than a narrowed subset. Null for an empty list. */
export function reviewFullBrush(entries: readonly LogEntry[]): BrushRange | null {
  return entries.length > 0 ? { anchor: 0, focus: entries.length - 1 } : null;
}

/** Whether a brush spans the entire list. A full span over a review's commits is
 * the whole review, modelled as no subrange so its diff renders via the pin. */
export function isFullBrush(entries: readonly LogEntry[], range: BrushRange): boolean {
  const { top, bottom } = brushBounds(range);
  return top === 0 && bottom === entries.length - 1;
}

/** How much of a review a SHA-anchored subrange covers, against the current ranged
 * log: `{ selected, total }` for the "N of M commits" label, or null when the
 * subrange no longer fits the log (rewritten history). */
export function reviewSubrangeExtent(
  entries: readonly LogEntry[],
  subrange: CommitSelection,
): { selected: number; total: number } | null {
  const range = brushFromSelection(entries, subrange);
  if (range === null) {
    return null;
  }
  const { top, bottom } = brushBounds(range);
  return { selected: bottom - top + 1, total: entries.length };
}

/** The affordance line under the brush: "3 commits + uncommitted". */
export function brushSummary(entries: readonly LogEntry[], range: BrushRange): string {
  const { top, bottom } = brushBounds(range);
  const selected = entries.slice(top, bottom + 1);
  const commitCount = selected.filter((entry) => entry.kind === "commit").length;
  const withUncommitted = selected.some((entry) => entry.kind === "uncommitted");
  if (commitCount === 0) {
    return withUncommitted ? "uncommitted changes" : "no selection";
  }
  const commits = countLabel(commitCount, "commit");
  return withUncommitted ? `${commits} + uncommitted` : commits;
}

/** What the log can no longer name: a selection whose shas are not in the current
 * list (rewritten history, or a log that hasn't loaded). The abbreviated sha is all
 * that is left to say — everything a human would recognise it by lives in the entry
 * this selection can no longer be matched to. */
function staleCommitLabel(selection: CommitSelection): string {
  switch (selection.kind) {
    case "uncommitted":
      return "Uncommitted changes";
    case "commitRangeWithUncommitted":
      return `Commits since ${abbreviate(selection.first)}`;
    case "commitRange":
      return selection.first === selection.last
        ? `Commit ${abbreviate(selection.first)}`
        : `Commits ${abbreviate(selection.first)} → ${abbreviate(selection.last)}`;
    default:
      return assertNever(selection);
  }
}

/** What a brushed band is *called* — the one line the rail shows for it.
 *
 * A single commit reads as its own subject, because that is what a human calls a
 * commit; the sha is machine identity and says nothing about which change this is.
 * Anything wider is a count ("3 commits + uncommitted"), because nobody reads a range
 * by its endpoints either. */
export function commitRangeLabel(entries: readonly LogEntry[], range: BrushRange): string {
  const { top, bottom } = brushBounds(range);
  if (top === bottom) {
    const entry = entries[top];
    return entry === undefined || entry.kind === "uncommitted"
      ? "Uncommitted changes"
      : entry.commit.subject;
  }
  // Every wider band holds at least one commit, so the summary always opens on a
  // digit and needs no sentence-casing.
  return brushSummary(entries, range);
}

/** The same label for a settled selection. Only one the log cannot place falls back to
 * shas, where there is genuinely nothing else left to print. */
export function commitSelectionLabel(
  entries: readonly LogEntry[] | null,
  selection: CommitSelection,
): string {
  if (entries === null) {
    return staleCommitLabel(selection);
  }
  const range = brushFromSelection(entries, selection);
  return range === null ? staleCommitLabel(selection) : commitRangeLabel(entries, range);
}

/** Stable identity for a log row across refreshes (shas survive, indexes don't). */
export function logEntryKey(entry: LogEntry): CommitSha | "uncommitted" {
  return entry.kind === "uncommitted" ? "uncommitted" : entry.commit.sha;
}
