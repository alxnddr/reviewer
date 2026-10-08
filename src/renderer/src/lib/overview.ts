import type { AnchorSpan, Comment, ReviewLayer, ReviewLayerRange } from "../../../shared/review";
import { countLabel } from "../../../shared/plural";
import { changedLines, type ChangedLines } from "../../../tools/review-coverage";
import { effectiveLayers } from "./coverage";
import type { FileChangeStatus, PatchFile } from "../../../shared/diff/patch";
import { hunkSnippet, representativeAnchors, spanIndex, type HunkSnippet } from "./diff/snippet";
import { isMachineWritten } from "./initial-folds";
import { layerOutline, layerOwning, rangeSpans, resolveLayerScroll } from "../../../shared/layers";
import {
  layerTally,
  nextUnreadLayer,
  readPaths,
  tallyRead,
  type ReadFiles,
  type ReadTally,
} from "./read-progress";

// The tour doc's model: the artifact's authored prose (the overview body, each layer's
// `summary` and `description`, a range's `note`) is the only part a human writes — every
// *number* the doc shows is derived here, from the same `layers` the rail steps and the
// same loaded diff the code view renders. That is the contract: nothing countable is ever
// read out of the artifact, so a review can't claim three comments while the app holds
// five, and a hand-authored table of contents can't drift the moment a layer moves. Pure and
// render-free — the screen maps this to elements and owns nothing but styling and
// navigation.

/** How much a chapter's hunk card shows: the anchor's rows with two unchanged rows either side,
 * capped at sixteen — enough for the key hunk of a chapter to be read beside its prose (the
 * guide's right column), short enough that ten chapters still scan as a document. */
const SNIPPET_OPTIONS = { context: 2, maxLines: 16 } as const;

/** Where a chapter's card came from: the author's `focus` (the hunk they say represents the
 * chapter), or the app's pick among its ranges when there is no focus or it drifted. */
export type ChapterSnippetSource = "focus" | "range";

export type ChapterSnippet = { file: string; snippet: HunkSnippet; source: ChapterSnippetSource };

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
  /** The line the author wrote about this file's part in the chapter, or null. The *first*
   * note among the chapter's ranges in this file, in authored order — the rule the schema
   * states and the reason it is decided here rather than at the row: a chapter's ranges are
   * already flattened over its whole extent in authored order by the time they reach this
   * function, so "first" means the same thing as it does in the file the author wrote. */
  note: string | null;
};

/** A chapter of the doc: one layer, projected against the loaded diff. Every figure is the
 * layer's *extent* — its own ranges plus everything nested under it — so a group states
 * the totals of what it contains and a leaf states its own, by one rule. */
export type OverviewChapter = {
  layer: ReviewLayer;
  /** 0-based nesting depth. The doc's *sections* render it as heading rank (§4, §4.2,
   * §4.2.1) and never as an indent — every section is read at one width, whatever its
   * depth. */
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
  /** How many of those carry `severity: "blocking"` — the one level that changes what the
   * reader does next, and therefore the only one the doc breaks the count down by. The
   * other two are read on the finding, not counted on the way to it. */
  blocking: number;
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
  /** The author marked this layer (or one it hangs off) `skim`: the mechanical remainder,
   * there so the lines are covered and navigable rather than so they are read. The doc sets
   * it denser and says so; the diff opens its files folded (`lib/initial-folds.ts`).
   *
   * Inherited down the tree, unlike every other field here, which are the layer's own or its
   * extent's totals. A skim parent means its sections are skim — marking a group mechanical
   * and then having its children render full-size would be the mark doing nothing. Nothing
   * about progress or coverage reads it: a skim chapter counts exactly like any other. */
  skim: boolean;
  /** The chapter's key hunk as a card: the layer's own `focus` when it places, else the most
   * representative hunk of its extent that places (`chapterSnippet`), or null (a layer whose
   * extent carries no range, a drifted layer, or an unloaded diff). */
  snippet: ChapterSnippet | null;
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
 * the chapter's entire range list to filter. Each line is then a binary search over the file's
 * spans (`spanIndex`), not a test of every one: a whole-file range is one span per hunk, and a
 * PR's file can carry tens of thousands of hunks. */
function coveredIn(
  changed: ChangedLines,
  ranges: readonly AnchorSpan[],
): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  const index = spanIndex(ranges);
  for (const side of ["additions", "deletions"] as const) {
    for (const line of changed[side]) {
      if (!index.holds(side, line)) {
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

/** The chapter's card: its `focus` first — the author's pick of the hunk that represents it,
 * which is often not the first range (a chapter whose first file is a fixture beside the real
 * change). A focus that no longer places falls through rather than leaving the chapter without
 * a card. Without one the app picks (`representativeAnchors` in `lib/diff/snippet.ts`): the
 * chapter's biggest hand-written file and a declaration in it, never just the first range —
 * which for a chapter that adds a file was its imports. Each file's spans come through
 * `rangeSpans`, so a whole-file range offers every hunk of its file to the pick. */
function chapterSnippet(
  focus: AnchorSpan | undefined,
  ranges: readonly ReviewLayerRange[],
  byPath: ReadonlyMap<string, PatchFile>,
): ChapterSnippet | null {
  const focusFile = focus === undefined ? undefined : byPath.get(focus.file);
  if (focus !== undefined && focusFile !== undefined) {
    const snippet = hunkSnippet(focusFile.fileDiff, focus, SNIPPET_OPTIONS);
    if (snippet !== null) {
      return { file: focus.file, snippet, source: "focus" };
    }
  }
  const spansByPath = new Map<string, { file: PatchFile; spans: AnchorSpan[] }>();
  for (const range of ranges) {
    const file = byPath.get(range.file);
    if (file === undefined) {
      continue;
    }
    const entry = spansByPath.get(file.path) ?? { file, spans: [] };
    entry.spans.push(...rangeSpans(range, file));
    spansByPath.set(file.path, entry);
  }
  for (const pick of representativeAnchors([...spansByPath.values()], isMachineWritten)) {
    const snippet = hunkSnippet(pick.file.fileDiff, pick.anchor, {
      ...SNIPPET_OPTIONS,
      lead: pick.lead,
    });
    if (snippet !== null) {
      return { file: pick.file.path, snippet, source: "range" };
    }
  }
  return null;
}

/** Every chapter's card, by layer id — the one part of the model that reads code rather than
 * counts it (an outline per file, a hunk walk per card), and so the one part kept out of
 * `buildOverview`'s other inputs. It is a function of the layers and the diff alone: the screen
 * memoises it on exactly those (`OverviewScreen.tsx`) and hands it in, so marking a file read or
 * editing a comment — both of which re-run `buildOverview` — does not re-pick a single card.
 * Folding it back into the model is what once made every Reviewed toggle cost 6.6 s on a
 * 12k-line file. */
export type ChapterSnippets = ReadonlyMap<string, ChapterSnippet | null>;

export function buildChapterSnippets({
  layers,
  files,
}: Pick<OverviewInput, "layers" | "files">): ChapterSnippets {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const effective = layers.length === 0 ? [] : effectiveLayers(files, layers);
  const outline = new Map(layerOutline(layers).map((entry) => [entry.layer.id, entry]));
  return new Map(
    effective.map((layer) => {
      // The extent, as `buildOverview` reads it: a group's card is picked from all it contains.
      const subtree = outline.get(layer.id)?.subtree ?? [layer];
      const ranges = subtree.flatMap((current) => current.ranges);
      return [layer.id, chapterSnippet(layer.focus, ranges, byPath)];
    }),
  );
}

/** The whole tour, derived. Every count here is measured against the diff on screen, so
 * an overview opened on a drifted branch honestly shows fewer files and flags the
 * chapters that no longer place, rather than reprinting what the artifact once claimed.
 * `snippets` defaults to being derived here, for callers with nothing to memoise (tests); the
 * screen passes its own (`buildChapterSnippets`). */
export function buildOverview(
  { layers, files, comments, frozen, readFiles }: OverviewInput,
  snippets: ChapterSnippets = buildChapterSnippets({ layers, files }),
): OverviewModel {
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
      const forFile = rangesByPath.get(path) ?? [];
      // Through `rangeSpans`, so a whole-file range counts every changed line of its file.
      const spans = forFile.flatMap((range) => rangeSpans(range, byPath.get(path)));
      const counts =
        changed === undefined ? { additions: 0, deletions: 0 } : coveredIn(changed, spans);
      additions += counts.additions;
      deletions += counts.deletions;
      entries.push({
        path,
        status: byPath.get(path)?.status ?? null,
        additions: counts.additions,
        deletions: counts.deletions,
        read: read.has(path),
        // First note wins (shared/review.ts). The bucket is in authored order because
        // `ranges` above is, so this is the first note the author wrote for this file in
        // this chapter — not the first range, which may carry none while a later one does.
        note: forFile.find((range) => range.note !== undefined)?.note ?? null,
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
      blocking: held.filter((comment) => comment.severity === "blocking").length,
      firstCommentId: held[0]?.id ?? null,
      read: layerTally(files, layer, layers, readFiles),
      outdated: resolveLayerScroll(layer, layers, files, frozen).kind === "outdated",
      // The entry's ancestors, not just the layer, so the mark carries down a group. The
      // inferred "not covered by layers" chapter is in no outline and so is never skim,
      // which is right: nobody marked those files anything.
      skim: layer.skim === true || (entry?.ancestors ?? []).some((a) => a.skim === true),
      snippet: snippets.get(layer.id) ?? null,
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

/** A chapter's comment count as the doc prints it: `5 comments`, or `2 blocking · 3 others`
 * once one of them carries the level that changes what the reader does next.
 *
 * Only `blocking` breaks out. A three-way split would spend a row's remaining width
 * restating the pills the findings already wear, and `important`/`minor` are read *on* a
 * finding, not counted on the way to one — the count's job here is to tell a reader
 * choosing where to start whether this chapter can be deferred. A review whose comments
 * carry no severity at all renders exactly the count it did before this existed, which is
 * the compatibility rule every one of these fields ships under.
 *
 * Pure, and beside the figures it labels, so it is tested without a document. */
export function chapterCommentLabel(comments: number, blocking: number): string {
  if (blocking === 0) {
    return countLabel(comments, "comment");
  }
  const others = comments - blocking;
  return others <= 0
    ? `${blocking} blocking`
    : `${blocking} blocking · ${countLabel(others, "other")}`;
}
