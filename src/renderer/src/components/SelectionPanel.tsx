import type { ReactElement } from "react";
import { ArrowUpDown, GitBranch, GitCompare, GitCompareArrows, History } from "lucide-react";
import { assertNever } from "../../../shared/assert";
import type { DiffSelection, LogEntry, ReviewRef } from "../../../shared/git";
import { BranchField } from "@/components/BranchField";
import { CommitBrushList } from "@/components/CommitBrushList";
import { GitFailureText } from "@/components/GitFailureText";
import { RAIL_GLYPH, RailFoot, RailNote, RailSection } from "@/components/rail";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { TooltipHint } from "@/components/ui/tooltip";
import { shortRef } from "@/lib/refs";
import {
  brushBounds,
  commitRangeLabel,
  commitSelectionLabel,
  reviewSubrangeExtent,
  type BrushRange,
} from "@/lib/selection";
import { cn } from "@/lib/utils";
import { selectActiveSlice, useReviewStore } from "@/stores/review";

// The diff selector: which changes the whole session is about. It is the outermost of
// the rail's four sections — diff → overview → layers → comments → files, widest scope
// first — and its bar is the same `RailSection` the three below it use.
//
// It used to be a 44px header with a ghost *button* inside it carrying the selection in
// mono, which the rail has no other example of: every other section in the rail IS its
// own control. And opening it swapped the entire rail out for a picker with nothing at
// the top to say what had happened, so the one fact the reviewer needed while choosing —
// what they are looking at now — was the fact that disappeared. Now the bar stays put,
// says what is loaded whether it is open or shut, and its twisty is the way back.
//
// Inside, there are no modes and no sources to switch between: there is one list of
// commits and two refs that decide which commits are in it.
//
//   Branch      — whose history you are reading.
//   Compare to  — optional. Set it, and the list holds exactly what the branch adds
//                 over that ref: the same commits a pull request lists, and every one
//                 of them still brushable.
//
// Before this, a comparison and a commit list were two separate "sources" that took
// turns, so choosing `main → feature/x` showed you a diff and *no* commits — you could
// see a range or pick within one, never both. They were never two things. A comparison
// IS a range of commits; brushing the whole range is the comparison and brushing part
// of it is a narrower diff, which is exactly how a review session's own subrange works
// (see `planDiff`). One list, one gesture, no flag that can disagree with the screen.

/** The line the section bar carries: what the diff on screen *is*. Plain text — no
 * mono, no markup — so the bar can hand the same string to its truncation hint.
 *
 * It reads the brush, not the settled selection, wherever the brush is what drives the
 * diff: the band a reviewer is dragging is the thing they are choosing, and the count
 * has to move while they drag it or the bar is a readout of the past. `commitBrush`
 * commits on release, so once the drag is over the two say the same thing anyway. */
function useSelectionLabel(): string {
  const selection = useReviewStore((state) => selectActiveSlice(state)?.selection ?? null);
  const base = useReviewStore((state) => selectActiveSlice(state)?.base ?? null);
  const head = useReviewStore((state) => selectActiveSlice(state)?.head ?? null);
  const brush = useReviewStore((state) => selectActiveSlice(state)?.brush ?? null);
  const reviewOrigin = useReviewStore((state) => selectActiveSlice(state)?.reviewOrigin ?? null);
  const reviewSubrange = useReviewStore(
    (state) => selectActiveSlice(state)?.reviewSubrange ?? null,
  );
  const entries = useReviewStore((state) => {
    const log = selectActiveSlice(state)?.log ?? null;
    return log !== null && log.phase === "loaded" ? log.entries : null;
  });

  // A review session names its fixed endpoints, never a repo picker's selection, with
  // a badge for as much of the review as the brush holds — a full brush is the whole
  // review and says so by saying nothing.
  if (reviewOrigin !== null) {
    const range = refRange(reviewOrigin.base, reviewOrigin.head);
    const extent =
      entries !== null && brush !== null
        ? brushExtent(entries, brush)
        : reviewSubrange !== null && entries !== null
          ? reviewSubrangeExtent(entries, reviewSubrange)
          : null;
    return extent === null || extent.selected === extent.total
      ? range
      : `${range} · ${extent.selected} of ${extent.total} commits`;
  }
  // A repo session reads its own picker the same way: the endpoints when the whole
  // comparison is on screen, the brushed range when it is narrower than that.
  if (entries !== null && brush !== null) {
    if (base !== null && head !== null) {
      const extent = brushExtent(entries, brush);
      return extent.selected === extent.total
        ? `${base} → ${head}`
        : `${base} → ${head} · ${extent.selected} of ${extent.total} commits`;
    }
    return commitRangeLabel(entries, brush);
  }
  return describeSelection(selection, entries);
}

/** How much of the log a live brush covers, in the shape `reviewSubrangeExtent`
 * reports for a settled one. */
function brushExtent(entries: LogEntry[], brush: BrushRange): { selected: number; total: number } {
  const { top, bottom } = brushBounds(brush);
  return { selected: bottom - top + 1, total: entries.length };
}

/** Two endpoints as one phrase. The arrow, not the `…` this used to print: an ellipsis
 * between two names reads as *elision* — the thing every other truncated label in the
 * rail means by it — where the two refs are in fact both fully there, and the direction
 * (from base, to head) is the part a reader actually has to know. */
function refRange(base: ReviewRef, head: ReviewRef): string {
  return `${shortRef(base)} → ${shortRef(head)}`;
}

function describeSelection(selection: DiffSelection | null, entries: LogEntry[] | null): string {
  if (selection === null) {
    return "Select a diff";
  }
  switch (selection.kind) {
    case "branches":
      return `${selection.base} → ${selection.head}`;
    case "reviewRefs":
      return refRange(selection.base, selection.head);
    case "uncommitted":
    case "commitRange":
    case "commitRangeWithUncommitted":
      return commitSelectionLabel(entries, selection);
    default:
      return assertNever(selection);
  }
}

type SelectionRowProps = {
  expanded: boolean;
  onToggle: () => void;
  /** True while there is nothing to collapse back to — an unloaded diff has no file
   * tree, so the picker is the rail and the twisty has no second state to offer. */
  locked: boolean;
};

/** The rail's top bar: what is loaded, and the disclosure that opens the picker. */
export function SelectionRow({ expanded, onToggle, locked }: SelectionRowProps): ReactElement {
  const label = useSelectionLabel();

  return (
    <RailSection
      data-diff-section
      // Locked, the bar keeps the twisty's slot but not the twisty: there is no diff to
      // go back to, so a chevron there would be a control that does nothing.
      expanded={locked ? null : expanded}
      aria-expanded={expanded}
      disabled={locked}
      onSelect={onToggle}
      bordered={true}
      icon={<GitCompare aria-hidden="true" className={RAIL_GLYPH} />}
    >
      {/* The hint hangs off the label, not the bar: the bar is a full-width hit target
          that never clips, so only the label knows whether anything was cut off. */}
      <TooltipHint content={label} whenTruncated side="bottom" align="start">
        <span className="min-w-0 truncate">{label}</span>
      </TooltipHint>
    </RailSection>
  );
}

function SourceSkeleton(): ReactElement {
  return (
    <div aria-hidden="true" className="flex flex-col">
      {SKELETON_WIDTHS.map((width, index) => (
        <span key={index} className="flex h-11 shrink-0 items-center px-2">
          <Skeleton className={cn("h-3.5 bg-border", width)} />
        </span>
      ))}
    </div>
  );
}

/** What is coming: rows, at the height the rows will be. The placeholder used to be
 * three floating 16px bars on 12px of padding, which is a different shape from anything
 * that ever replaced it — so the panel jumped the moment the log arrived. */
const SKELETON_WIDTHS: string[] = ["w-3/4", "w-1/2", "w-5/6", "w-2/3", "w-4/5", "w-1/2"];

/** The two refs that decide what the list holds. They sit where the file tree keeps its
 * filter — controls above the list they act on — and they are the only chrome the picker
 * has, because they are the only choice it offers. */
function RangeFields(): ReactElement | null {
  const branches = useReviewStore((state) => selectActiveSlice(state)?.branches ?? null);
  const head = useReviewStore((state) => selectActiveSlice(state)?.head ?? null);
  const base = useReviewStore((state) => selectActiveSlice(state)?.base ?? null);
  const setHead = useReviewStore((state) => state.setHead);
  const setBase = useReviewStore((state) => state.setBase);
  const swapBranches = useReviewStore((state) => state.swapBranches);

  if (branches === null || branches.phase === "loading") {
    return null;
  }
  if (branches.phase === "failed") {
    return (
      <RailNote>
        <GitFailureText failure={branches.failure} />
      </RailNote>
    );
  }
  const list = branches.list.branches;
  if (list.length === 0) {
    return null;
  }
  return (
    <div className="flex shrink-0 flex-col gap-2 px-2 pt-2 pb-2.5">
      {/* Captioned, unlike the file filter below them: two fields stacked in the same
          manner, holding two branch names, cannot say which is which by their contents.
          The glyphs distinguish them at a glance; the captions settle it. */}
      <BranchField
        label="Branch"
        icon={<GitBranch aria-hidden="true" />}
        branches={list}
        value={head ?? branches.list.currentBranch}
        onChange={setHead}
      />
      {/* Optional by design, and visibly so: empty, the list is this branch's own
          history; filled, it is what the branch adds over that ref — the pull-request
          range, still every commit of it selectable. */}
      <BranchField
        label="Compare to"
        icon={<GitCompareArrows aria-hidden="true" />}
        placeholder="Nothing — its own history"
        branches={list}
        value={base}
        onChange={setBase}
        onClear={base === null ? undefined : () => setBase(null)}
        action={
          base === null ? undefined : (
            <TooltipHint content="Swap the two refs" side="left" align="center">
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => swapBranches()}
                aria-label="Swap the two refs"
                className="-my-1 text-text-muted hover:bg-border/60 hover:text-foreground dark:hover:bg-border/60"
              >
                <ArrowUpDown aria-hidden="true" />
              </Button>
            </TooltipHint>
          )
        }
      />
    </div>
  );
}

/** The commits those refs resolve to, and the brush over them. */
function CommitList(): ReactElement {
  const log = useReviewStore((state) => selectActiveSlice(state)?.log ?? null);
  const brush = useReviewStore((state) => selectActiveSlice(state)?.brush ?? null);
  const base = useReviewStore((state) => selectActiveSlice(state)?.base ?? null);

  if (log === null || log.phase === "loading") {
    return <SourceSkeleton />;
  }
  if (log.phase === "failed") {
    return (
      <RailNote>
        <GitFailureText failure={log.failure} />
      </RailNote>
    );
  }
  return (
    <CommitBrushList
      entries={log.entries}
      brush={brush}
      foot={
        <RailFoot>
          {base === null
            ? "Drag or shift-click to select a range"
            : "Drag or shift-click to narrow it"}
        </RailFoot>
      }
      emptyMessage={
        base === null ? "No commits and a clean working tree." : "No commits between these refs."
      }
    />
  );
}

/** A refs review's selector: a reset to the whole review and the brushable list of the
 * review's own commits — no branch source, no way to leave the review's diff. The
 * endpoints are not repeated here; the bar above already names them. */
function ReviewCommitsSection(): ReactElement {
  const log = useReviewStore((state) => selectActiveSlice(state)?.log ?? null);
  const brush = useReviewStore((state) => selectActiveSlice(state)?.brush ?? null);
  const reviewSubrange = useReviewStore(
    (state) => selectActiveSlice(state)?.reviewSubrange ?? null,
  );
  const resetReviewSubrange = useReviewStore((state) => state.resetReviewSubrange);

  return (
    <>
      {/* One source, so its bar never closes — and the way back to the whole review
          rides that bar as an action, exactly as the walkthrough's "Show all" does. It
          appears only once there is something to undo. */}
      <RailSection
        expanded={null}
        onSelect={() => resetReviewSubrange()}
        bordered={false}
        icon={<History aria-hidden="true" className={RAIL_GLYPH} />}
        action={
          reviewSubrange === null ? undefined : (
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0 hover:bg-border/60 dark:hover:bg-border/60"
              onClick={() => resetReviewSubrange()}
            >
              Full diff
            </Button>
          )
        }
      >
        Commits
      </RailSection>
      {log === null || log.phase === "loading" ? (
        <SourceSkeleton />
      ) : log.phase === "failed" ? (
        <RailNote>
          <GitFailureText failure={log.failure} />
        </RailNote>
      ) : (
        <CommitBrushList
          entries={log.entries}
          brush={brush}
          foot={<RailFoot>Drag or shift-click to narrow to a range</RailFoot>}
          emptyMessage="This review spans no commits to narrow."
        />
      )}
    </>
  );
}

/** The review-scoped selector: for a refs review, a brushable subset of the review's
 * own commits. Deliberately offers no branch/other-diff escape — a review session stays
 * on its review; the repo is opened separately to explore freely. */
function ReviewSelectionPanel(): ReactElement | null {
  const origin = useReviewStore((state) => selectActiveSlice(state)?.reviewOrigin ?? null);
  const frozen = useReviewStore(
    (state) => selectActiveSlice(state)?.reviewDiff?.kind === "frozenPatch",
  );

  if (origin === null) {
    return null;
  }
  return (
    <section aria-label="Review diff" className="flex min-h-0 flex-1 flex-col">
      {frozen ? (
        // A frozen review renders its embedded patch off git: there are no commits to
        // brush, so its range is read-only.
        <RailNote>
          This review carries a frozen patch, so its diff can’t be narrowed to individual commits.
        </RailNote>
      ) : (
        <ReviewCommitsSection />
      )}
    </section>
  );
}

/** The picker itself, under the bar. A review session gets the review-scoped selector;
 * a repo session gets both of its sources at once. */
export function SelectionPanel(): ReactElement | null {
  const hasSession = useReviewStore((state) => selectActiveSlice(state) !== null);
  const isReview = useReviewStore((state) => selectActiveSlice(state)?.reviewOrigin != null);

  if (!hasSession) {
    return null;
  }
  if (isReview) {
    return <ReviewSelectionPanel />;
  }
  return <RepoSelectionPanel />;
}

/** A repo session's picker: every source it can draw a diff from, then whichever one is
 * in use.
 *
 * The sources sit in one block with a rule under it. Without the rule the selected
 * source's fill and the selected commit's fill are two identical bands touching, and two
 * touching bands read as one selection of two rows — which is exactly what they are not.
 * The rule also says the true thing about the structure: above it, what the diff comes
 * from; below it, that source's own contents. */
function RepoSelectionPanel(): ReactElement {
  return (
    <section aria-label="Diff selection" className="flex min-h-0 flex-1 flex-col">
      <RangeFields />
      <CommitList />
    </section>
  );
}
