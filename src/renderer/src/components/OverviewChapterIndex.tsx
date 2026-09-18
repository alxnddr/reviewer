import { useState, type KeyboardEvent, type ReactElement } from "react";
import { AlertTriangle } from "lucide-react";
import { clamp } from "../../../shared/clamp";
import { countLabel } from "../../../shared/plural";
import type { OverviewChapter } from "@/lib/overview";
import { ChapterChip, LineCounts } from "@/components/OverviewLayerSection";
import { ReadRing, readLabel } from "@/components/ReadRing";
import { TooltipHint } from "@/components/ui/tooltip";

// The whole review at one glance: one line per chapter, between the author's prose and the
// sections themselves.
//
// The doc had no compact form of itself at any zoom. Its first screen was the opening
// prose and nothing else, and the *shape* of the review — how many chapters, what they
// are, which one is large, which one is unread — began below the fold and was only ever
// stated at full length, a paragraph and a file list at a time. So the prose was doing a
// job it was not written for: the skill's rules are about the argument of the change, not
// about orientation. This is the orientation layer, and the prose goes back to arguing.
//
// **It is derived, and that is the point.** Every surveyed tool has this row of the review
// and every one of them has the author write it, which means the table can disagree with
// the walkthrough it indexes. Here the author writes no index at all: the rows are
// `buildOverview`'s chapters, so a layer that moves, splits or vanishes moves, splits or
// vanishes here in the same render. The same argument the headline stats already make
// about counts, applied to the shape.
//
// Nothing on a row is authored beyond the label and the one-line summary the section below
// prints verbatim, and nothing on it is new: it is the section's own facts, set one line
// high. A group's figures are its extent's totals — its children's — by the rule every
// other surface follows (shared/layers.ts), so these columns describe chapters and are not
// a column to add up.
//
// It sits *below* the prose. Above would put the map first, which is defensible and is
// what the diagram-first tools do; below keeps the author's answer as the opening line of
// the document and leaves the reading order the reader already has. Cheaper to reverse
// than to argue about — it is one JSX move in OverviewScreen.

/** One nesting level, in px. The doc's sections deliberately refuse to indent — the
 * section number carries depth there, and every section is read at one width. A list is
 * the opposite case: it is read *down*, so the tree has to be legible in one pass along
 * its left edge, and a row is not prose whose measure an indent would disturb. Small
 * enough that the fifth level still clears the reading column. */
const INDENT_PX = 14;

/** The DOM id a row carries, so the arrow keys have something to move focus onto.
 *
 * Read back with `getElementById` and never spliced into a selector: a layer id is data,
 * and the inferred chapter's is `reviewer:uncovered`, whose `:` a selector parses as a
 * pseudo-class (dom-ids.test.ts). */
function rowDomId(layerId: string): string {
  return `overview-index-${layerId}`;
}

type OverviewChapterIndexProps = {
  /** The chapters to list, already filtered by `chapterIndex` — this renders what it is
   * given and decides nothing about whether there should be an index at all. */
  chapters: readonly OverviewChapter[];
  /** Open a chapter in the diff. The same call the section's heading makes below, because
   * it is the same door: an index whose rows landed somewhere else would be a second,
   * quieter navigation model for the same list. */
  onOpen: (layerId: string) => void;
};

export function OverviewChapterIndex({
  chapters,
  onOpen,
}: OverviewChapterIndexProps): ReactElement {
  // Roving tabindex: the index is **one** Tab stop, not one per chapter. The doc is already
  // a long run of stops — every section heading, up to six file rows in each, a read toggle
  // and a comment door — and a ten-chapter review would have doubled the distance from the
  // top of the page to the first section without adding a single new destination, since
  // every row here leads where a heading below already leads. Inside it the arrows move, as
  // they do in the rail's tree; the same idiom the tab strip uses (TabBar's `focusStop`).
  const [cursor, setCursor] = useState(0);
  // Clamped rather than trusted: `chapters` shrinks when a diff reloads with fewer layers,
  // and a cursor left past the end would leave no row holding the stop — an index nothing
  // could Tab into.
  const stop = clamp(cursor, 0, chapters.length - 1);

  const focusRow = (to: number): void => {
    const next = clamp(to, 0, chapters.length - 1);
    const target = chapters[next];
    if (target === undefined) {
      return;
    }
    setCursor(next);
    document.getElementById(rowDomId(target.layer.id))?.focus();
  };

  // An open key set, so this one takes a default — every key it does not claim is the
  // document's (PgDn scrolls, Tab leaves, the app's own chords fire).
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    switch (event.key) {
      case "ArrowDown":
        focusRow(stop + 1);
        break;
      case "ArrowUp":
        focusRow(stop - 1);
        break;
      case "Home":
        focusRow(0);
        break;
      case "End":
        focusRow(chapters.length - 1);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  return (
    // A hairline above and none below: the line separates the index from the prose it
    // follows, and the first chapter's own rule — the strongest horizontal line on the
    // page, by rankStyle's rule — closes the block from underneath. A border of its own
    // there would draw a second line 28px from that one for no new meaning. The top margin
    // is the index's, by the doc's rule that every gap belongs to what sits under it.
    <nav
      aria-label="Chapters"
      onKeyDown={onKeyDown}
      className="mt-7 flex flex-col border-t border-border pt-3"
    >
      {chapters.map((chapter, index) => {
        const { layer, read } = chapter;
        return (
          <button
            key={layer.id}
            id={rowDomId(layer.id)}
            type="button"
            tabIndex={index === stop ? 0 : -1}
            onFocus={() => setCursor(index)}
            onClick={() => onOpen(layer.id)}
            className="flex w-full items-center gap-x-3 rounded px-1.5 py-1 text-left hover:bg-border/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {/* The section number, in a column of its own — the one place the doc holds an
                aisle open for it. A section leads its heading with the number because a
                fixed gutter beside prose either clips `4.2.1` or reserves that width on
                every shallower heading on the page; a list is read *down*, and a column of
                numbers that do not line up is what makes one unscannable. The indent rides
                on this cell, so number and label shift together and the row reads as an
                outline entry. */}
            <span
              style={{ marginInlineStart: chapter.depth * INDENT_PX }}
              className="shrink-0 text-sm tabular-nums text-text-muted"
            >
              {chapter.ordinal ?? (
                <AlertTriangle aria-hidden="true" className="size-3.5 text-text-muted" />
              )}
            </span>
            {/* The section prints the label and the summary on two lines, as a heading and
                its deck. On one line they are one phrase, dimmed at the join, eliding from
                the right — so what a narrow pane cuts is the end of the summary and never
                the name of the chapter. The hint is on this span rather than on the row:
                it arms on *this* element clipping, and the row itself never clips. */}
            <TooltipHint
              content={
                layer.summary === undefined ? layer.label : `${layer.label} — ${layer.summary}`
              }
              whenTruncated
              side="top"
              align="start"
            >
              <span className="min-w-0 flex-1 truncate text-sm">
                <span className="text-foreground">{layer.label}</span>
                {layer.summary !== undefined && (
                  <span className="text-text-muted">{` — ${layer.summary}`}</span>
                )}
              </span>
            </TooltipHint>
            {/* The same chip the section below wears, and for the reason the flag exists:
                a drifted chapter has to read as drifted everywhere it is named (the rail,
                the section, and now here), or the index quietly promises a door that
                lands on a dead end. It is `shrink-0`, so the summary beside it gives up
                the width — the chapter is still named, and what gets cut is the end of a
                sentence. */}
            {chapter.outdated && <ChapterChip>Outdated</ChapterChip>}
            {/* And the same argument again for `Skim`, one step stronger: this row is where
                a reader decides which chapter to start on, so "there is nothing to read in
                this one" is exactly the fact they are here for. */}
            {chapter.skim && <ChapterChip>Skim</ChapterChip>}
            {/* The measured end of the row, in a fixed order — ring, files, lines — so the
                three read as columns down the list even though each can be absent. */}
            <span className="flex shrink-0 items-center gap-x-2.5 text-xs text-text-faint tabular-nums">
              {/* Nothing read draws nothing, as it does in the rail: a bare track on every
                  row is a column of empty circles down a review nobody has started, and a
                  status mark has to mean something by being there. The 12px slot stays
                  held open all the same (FileRow's rule) — the numbers to its right are a
                  column, and they must not step sideways the moment a chapter is opened.
                  The ring carries its own label here: the section says "3 of 5 read" in
                  words beside it, and a row this compact has no room to. */}
              <span className="flex size-3 shrink-0 items-center">
                {read.read > 0 && <ReadRing tally={read} label={readLabel(read)} />}
              </span>
              <span>{countLabel(chapter.files.length, "file")}</span>
              {(chapter.additions > 0 || chapter.deletions > 0) && (
                <LineCounts additions={chapter.additions} deletions={chapter.deletions} />
              )}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
