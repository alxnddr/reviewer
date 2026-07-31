import type { Comment, ReviewLayer } from "../../../shared/review";
import { changedLines, type ChangedLines } from "../../../tools/review-coverage";
import { effectiveLayers } from "./coverage";
import type { FileChangeStatus, PatchFile } from "../../../shared/diff/patch";
import { snippetForAnchor, type DiffSnippet } from "./diff/snippet";
import { layerOutline, layerOwning, resolveLayerScroll } from "../../../shared/layers";
import {
  layerTally,
  nextUnreadLayer,
  readPaths,
  tallyRead,
  type ReadFiles,
  type ReadTally,
} from "./read-progress";

// The tour doc's model: the artifact's authored prose (the overview body, each layer's
// `summary` and `description`) is the only part a human writes — every *number* the doc
// shows is derived here, from the same `layers` the rail steps and the same loaded diff
// the code view renders. That is the contract: nothing countable is ever read out of the
// artifact, so a review can't claim three comments while the app holds five, and a
// hand-authored table of contents can't drift the moment a layer moves. Pure and
// render-free — the screen maps this to elements and owns nothing but styling and
// navigation.

/** How much preview a chapter snippet shows. Six lines is a taste of the code — enough to
 * recognise the change, short enough that ten chapters still scan as a document. */
const SNIPPET_LINES = 6;

/** One file a chapter covers, with that chapter's own footprint in it — not the file's
 * totals. A layer that explains three lines of a 400-line file reads `+3`, because the
 * row describes the *chapter*, not the file. `status` is null when the loaded diff no
 * longer carries the file (the layer's anchors drifted off it). */
export type OverviewFileEntry = {
  path: string;
  status: FileChangeStatus | null;
  additions: number;
  deletions: number;
  /** Whether the reader has marked this file read. Always false for a file the loaded diff
   * no longer carries: a mark is made against content, and there is none here to have
   * read. */
  read: boolean;
};

/** A chapter of the doc: one layer, projected against the loaded diff. Every figure is the
 * layer's *extent* — its own ranges plus everything nested under it — so a group states
 * the totals of what it contains and a leaf states its own, by one rule. */
export type OverviewChapter = {
  layer: ReviewLayer;
  /** 0-based nesting depth, which the doc renders as heading rank (§4, §4.2, §4.2.1)
   * rather than as an indent: sections stay at one reading width whatever their depth. */
  depth: number;
  /** The section number — `"4"`, `"4.2"`, `"4.2.1"` — identical to the rail's and the
   * band's. Null for the inferred "not covered by layers" chapter, no authored step. */
  ordinal: string | null;
  /** Whether layers hang off this one. A group's own file rows are left to the sections
   * that follow it (they list exactly the same paths); it states the totals instead. */
  hasChildren: boolean;
  files: OverviewFileEntry[];
  /** Changed lines this chapter's extent covers, summed over its files. */
  additions: number;
  deletions: number;
  /** Comments inside this chapter's extent: those its own ranges own, plus every one
   * owned by a layer nested under it. */
  comments: number;
  /** The first of them, so the section's comment count is a door onto the finding itself
   * rather than a number. Null when the chapter holds none. */
  firstCommentId: string | null;
  /** How far through this chapter's extent the reader is — the same tally the rail's ring
   * and the chapter band's control read, from the same `layerTally`. Counted over the
   * files the loaded diff actually carries, so a chapter can be finished without chasing
   * code that has drifted out from under it. */
  read: ReadTally;
  /** Its extent's first range no longer places against the loaded diff — the same flag the
   * rail shows, so a drifted chapter reads as drifted in both places. */
  outdated: boolean;
  /** A few real lines from the first range that still places, or null (a layer whose
   * extent carries no range, a drifted layer, or an unloaded diff). */
  snippet: { file: string; snippet: DiffSnippet } | null;
};

/** Everything the overview screen renders below the authored prose. `chapters` is in
 * authored order with the inferred uncovered chapter last, exactly like the rail. */
export type OverviewModel = {
  chapters: OverviewChapter[];
  /** The whole diff, for the headline: changed files and total changed lines per side. */
  files: number;
  additions: number;
  deletions: number;
  comments: number;
  /** The reader's own progress over the whole diff, and where to pick it back up: the
   * first chapter in reading order with something left in it, or null when the review is
   * read out. Derived here beside every other figure the doc prints, for the same reason —
   * the doc is where the review is taken in as a whole, so it is where "how far am I" and
   * "where was I" have to be answered from one source. */
  read: ReadTally;
  resumeLayerId: string | null;
};

export type OverviewInput = {
  layers: readonly ReviewLayer[];
  /** The full loaded diff, or an empty list when none is loaded yet: the doc still reads
   * (prose, chapters, file names), it just carries no counts or previews. */
  files: readonly PatchFile[];
  comments: readonly Comment[];
  /** A frozen review places every anchor, so nothing reads as outdated. */
  frozen: boolean;
  /** The reader's marks. The one input here that is not the artifact or the diff — and the
   * reason the doc can be a dashboard as well as a document. */
  readFiles: ReadFiles;
};

/** How many of a file's changed lines, per side, this chapter's ranges cover. `ranges` is
 * expected to already be narrowed to `path` — the caller buckets a chapter's whole-extent
 * ranges by file once (`rangesByPath` below) rather than handing every file's changed lines
 * the chapter's entire range list to filter, which used to make this O(changed lines ×
 * chapter ranges) instead of O(changed lines × that file's ranges). */
function coveredIn(
  changed: ChangedLines,
  ranges: readonly {
    side: "additions" | "deletions";
    startLine: number;
    endLine: number;
  }[],
): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const side of ["additions", "deletions"] as const) {
    for (const line of changed[side]) {
      const covered = ranges.some(
        (range) => range.side === side && range.startLine <= line && line <= range.endLine,
      );
      if (!covered) {
        continue;
      }
      if (side === "additions") {
        additions += 1;
      } else {
        deletions += 1;
      }
    }
  }
  return { additions, deletions };
}

/** The first of a chapter's ranges that still resolves to real lines in the diff — the
 * code a preview would show. Ranges are tried in authored order, so a layer previews the
 * code its author put first, not whatever happens to be earliest in the file tree. */
function firstSnippet(
  ranges: readonly {
    file: string;
    side: "additions" | "deletions";
    startLine: number;
    endLine: number;
  }[],
  byPath: ReadonlyMap<string, PatchFile>,
): { file: string; snippet: DiffSnippet } | null {
  for (const range of ranges) {
    const file = byPath.get(range.file);
    if (file === undefined) {
      continue;
    }
    const snippet = snippetForAnchor(file.fileDiff, range, SNIPPET_LINES);
    if (snippet !== null) {
      return { file: range.file, snippet };
    }
  }
  return null;
}

/** The whole tour, derived. Every count here is measured against the diff on screen, so
 * an overview opened on a drifted branch honestly shows fewer files and flags the
 * chapters that no longer place, rather than reprinting what the artifact once claimed. */
export function buildOverview({
  layers,
  files,
  comments,
  frozen,
  readFiles,
}: OverviewInput): OverviewModel {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const read = readPaths(files, readFiles);
  const changedByPath = new Map(files.map((file) => [file.path, changedLines(file)]));

  // The authored chapters plus the inferred "not covered by layers" one — from
  // `effectiveLayers` itself, the same list the rail and the solo machinery read, so every
  // surface offers the same set of stops and one walk of the diff produces it.
  //
  // The one thing that is this doc's alone is the guard: a review with no layers at all is
  // "entirely uncovered" by the coverage core's rule, but there is no walkthrough for
  // anything to be missing from — listing the whole diff as one not-covered chapter would
  // be a table of contents for a book with no chapters.
  const effective = layers.length === 0 ? [] : effectiveLayers(files, layers);

  // Ownership is exclusive and sits at the deepest layer that claims the lines
  // (`layerOwning`), so a comment is explained by the most specific section that covers
  // it. Ancestors do not lose it — they count it by aggregation below.
  const ownerOf = new Map<string, string>();
  for (const comment of comments) {
    const owner = layerOwning(effective, comment);
    if (owner !== null) {
      ownerOf.set(comment.id, owner.id);
    }
  }

  // The outline the rail and the band read too: each layer's depth, section number, and
  // extent. Keyed by id; the inferred chapter is in no outline and simply misses.
  const outline = new Map(layerOutline(layers).map((entry) => [entry.layer.id, entry]));
  const chapters = effective.map((layer): OverviewChapter => {
    const entry = outline.get(layer.id);
    // The layer's extent: its own ranges plus everything nested under it. A group's
    // figures are therefore the totals of what it contains, by the same rule that gives a
    // leaf its own — nothing about a group is a special case.
    const subtree = entry?.subtree ?? [layer];
    const ranges = subtree.flatMap((current) => current.ranges);
    const paths = new Set(ranges.map((range) => range.file));
    // Bucketed once per chapter so `coveredIn` below scans only the ranges that could
    // possibly cover a given file's lines, not the whole chapter's (every other file's too).
    const rangesByPath = new Map<string, typeof ranges>();
    for (const range of ranges) {
      const forFile = rangesByPath.get(range.file);
      if (forFile === undefined) {
        rangesByPath.set(range.file, [range]);
      } else {
        forFile.push(range);
      }
    }
    let additions = 0;
    let deletions = 0;
    const entries: OverviewFileEntry[] = [];
    for (const path of paths) {
      const changed = changedByPath.get(path);
      const counts =
        changed === undefined
          ? { additions: 0, deletions: 0 }
          : coveredIn(changed, rangesByPath.get(path) ?? []);
      additions += counts.additions;
      deletions += counts.deletions;
      entries.push({
        path,
        status: byPath.get(path)?.status ?? null,
        additions: counts.additions,
        deletions: counts.deletions,
        read: read.has(path),
      });
    }
    // Comments held anywhere in the extent, in comment order so "the first one" is a
    // stable door onto the finding.
    const within = new Set(subtree.map((current) => current.id));
    const held = comments.filter((comment) => {
      const owner = ownerOf.get(comment.id);
      return owner !== undefined && within.has(owner);
    });
    return {
      layer,
      depth: entry?.depth ?? 0,
      ordinal: entry?.ordinal ?? null,
      hasChildren: (entry?.children.length ?? 0) > 0,
      files: entries,
      additions,
      deletions,
      comments: held.length,
      firstCommentId: held[0]?.id ?? null,
      read: layerTally(files, layer, layers, readFiles),
      outdated: resolveLayerScroll(layer, layers, files, frozen).kind === "outdated",
      snippet: firstSnippet(ranges, byPath),
    };
  });

  let additions = 0;
  let deletions = 0;
  for (const changed of changedByPath.values()) {
    additions += changed.additions.size;
    deletions += changed.deletions.size;
  }

  return {
    chapters,
    files: files.length,
    additions,
    deletions,
    comments: comments.length,
    read: tallyRead(files, readFiles),
    // Over the *effective* list, so a review whose only unread work sits in files no layer
    // walks resumes into the inferred "not covered" chapter rather than reporting itself
    // finished — the same list the rail offers as stops.
    resumeLayerId: nextUnreadLayer(files, effective, readFiles),
  };
}
