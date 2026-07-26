import type { ReactElement } from "react";
import { Check, GitBranch, GitCompare, History } from "lucide-react";
import { assertNever } from "../../../shared/assert";
import type { ReviewRef } from "../../../shared/git";
import type { SelectionMode } from "../../../shared/session";
import { BranchComparePicker } from "@/components/BranchComparePicker";
import { BranchHeading, CommitBrushList } from "@/components/CommitBrushList";
import { GitFailureText } from "@/components/GitFailureText";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { TooltipHint } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { shortRef } from "@/lib/refs";
import { brushSummary, reviewSubrangeExtent } from "@/lib/selection";
import { selectActiveSlice, useReviewStore } from "@/stores/review";

function isSelectionMode(value: unknown): value is SelectionMode {
  return value === "commits" || value === "branches";
}

// Selected state: themed fill (bg-selected) plus full ink.
const MODE_ITEM_CLASS =
  "text-sm text-text-muted aria-pressed:bg-selected aria-pressed:text-foreground";

type ModeSwitchProps = {
  mode: SelectionMode;
};

function ModeSwitch({ mode }: ModeSwitchProps): ReactElement {
  const setMode = useReviewStore((state) => state.setMode);

  return (
    <ToggleGroup
      value={[mode]}
      onValueChange={(groupValue) => {
        const next = groupValue[0];
        if (isSelectionMode(next)) {
          setMode(next);
        }
      }}
      variant="outline"
      size="sm"
      spacing={0}
      aria-label="Diff selection mode"
      className="w-full *:flex-1"
    >
      <ToggleGroupItem value="commits" aria-label="Commits" className={MODE_ITEM_CLASS}>
        <History aria-hidden="true" />
        Commits
      </ToggleGroupItem>
      <ToggleGroupItem value="branches" aria-label="Branches" className={MODE_ITEM_CLASS}>
        <GitBranch aria-hidden="true" />
        Branches
      </ToggleGroupItem>
    </ToggleGroup>
  );
}

function SourceSkeleton(): ReactElement {
  return (
    <div aria-hidden="true" className="space-y-3 px-2 py-3">
      <Skeleton className="h-4 w-3/4 bg-border" />
      <Skeleton className="h-4 w-2/3 bg-border" />
      <Skeleton className="h-4 w-4/5 bg-border" />
    </div>
  );
}

function CommitsSection(): ReactElement {
  const log = useReviewStore((state) => selectActiveSlice(state)?.log ?? null);
  const brush = useReviewStore((state) => selectActiveSlice(state)?.brush ?? null);
  const branches = useReviewStore((state) => selectActiveSlice(state)?.branches ?? null);

  if (log === null || log.phase === "loading") {
    return <SourceSkeleton />;
  }
  if (log.phase === "failed") {
    return (
      <p className="px-2 py-3 text-xs text-text-muted">
        <GitFailureText failure={log.failure} />
      </p>
    );
  }
  // Branches load alongside the log on the same open, so the ref the list walks is
  // known here; a failed/pending branch load degrades to a detached-HEAD heading.
  const currentBranch =
    branches !== null && branches.phase === "loaded" ? branches.list.currentBranch : null;
  return (
    <CommitBrushList
      entries={log.entries}
      brush={brush}
      heading={<BranchHeading branch={currentBranch} />}
      summary={brush !== null ? brushSummary(log.entries, brush) : null}
      emptyMessage="No commits and a clean working tree."
    />
  );
}

function BranchesSection(): ReactElement {
  const branches = useReviewStore((state) => selectActiveSlice(state)?.branches ?? null);

  if (branches === null || branches.phase === "loading") {
    return <SourceSkeleton />;
  }
  if (branches.phase === "failed") {
    return (
      <p className="px-2 py-3 text-xs text-text-muted">
        <GitFailureText failure={branches.failure} />
      </p>
    );
  }
  return <BranchComparePicker branches={branches.list.branches} />;
}

/** The two refs a review is between — its fixed endpoints, never editable in a
 * review session. Typography mirrors the Base/Head heading in commits mode; a full
 * sha reads short, a branch name verbatim. */
function ReviewRangeHeading({ base, head }: { base: ReviewRef; head: ReviewRef }): ReactElement {
  return (
    <div className="flex flex-col gap-1 px-2 pb-2">
      <span className="text-xs text-text-muted">Reviewing</span>
      <span className="flex items-center gap-1.5 text-sm">
        {/* A ref the heading abbreviated (a sha cut to its short form) is worth
            recovering however wide the rail is; one shown verbatim only needs the
            hint once it clips. */}
        <TooltipHint
          content={base}
          whenTruncated={shortRef(base) === base}
          side="bottom"
          align="start"
        >
          <span className="min-w-0 truncate font-mono text-foreground">{shortRef(base)}</span>
        </TooltipHint>
        <span aria-hidden="true" className="shrink-0 text-text-muted">
          …
        </span>
        <TooltipHint
          content={head}
          whenTruncated={shortRef(head) === head}
          side="bottom"
          align="start"
        >
          <span className="min-w-0 truncate font-mono text-foreground">{shortRef(head)}</span>
        </TooltipHint>
      </span>
    </div>
  );
}

/** The reset row pinned above the review's commit list: selecting it drops any
 * subrange back to the whole review (the authored diff), and it reads active while
 * the whole range is what's shown. */
function FullReviewRow({
  active,
  onSelect,
}: {
  active: boolean;
  onSelect: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onSelect}
      className={cn(
        "mb-1 flex min-h-8 items-center gap-2 rounded-md px-2 text-sm outline-none select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        active ? "bg-selected text-foreground" : "text-text-muted hover:bg-border/30",
      )}
    >
      <GitCompare aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="flex-1 text-left">Full review diff</span>
      {active && <Check aria-hidden="true" className="size-3.5 shrink-0" />}
    </button>
  );
}

/** A refs review's selector: the fixed endpoints, a reset to the whole review, and
 * the brushable list of the review's own commits — no branch pickers, no way to
 * leave the review's diff. */
function ReviewCommitsSection({ base, head }: { base: ReviewRef; head: ReviewRef }): ReactElement {
  const log = useReviewStore((state) => selectActiveSlice(state)?.log ?? null);
  const brush = useReviewStore((state) => selectActiveSlice(state)?.brush ?? null);
  const reviewSubrange = useReviewStore(
    (state) => selectActiveSlice(state)?.reviewSubrange ?? null,
  );
  const resetReviewSubrange = useReviewStore((state) => state.resetReviewSubrange);

  if (log === null || log.phase === "loading") {
    return <SourceSkeleton />;
  }
  if (log.phase === "failed") {
    return (
      <div className="flex min-h-0 flex-col">
        <ReviewRangeHeading base={base} head={head} />
        <p className="px-2 py-3 text-xs text-text-muted">
          <GitFailureText failure={log.failure} />
        </p>
      </div>
    );
  }
  const extent = reviewSubrange === null ? null : reviewSubrangeExtent(log.entries, reviewSubrange);
  // The whole review reads as "All N commits" rather than dropping the line, so the
  // list below never jumps as the reviewer narrows to a subrange and back.
  const summary =
    extent === null
      ? log.entries.length === 1
        ? "1 commit"
        : `All ${log.entries.length} commits`
      : `${extent.selected} of ${extent.total} commits`;
  const heading = (
    <>
      <ReviewRangeHeading base={base} head={head} />
      <FullReviewRow active={reviewSubrange === null} onSelect={() => resetReviewSubrange()} />
    </>
  );
  return (
    <CommitBrushList
      entries={log.entries}
      brush={brush}
      heading={heading}
      summary={summary}
      emptyMessage="This review spans no commits to narrow."
    />
  );
}

/** A frozen review renders its embedded patch off git: there are no commits to
 * brush, so the endpoints are read-only. */
function FrozenReviewNote({ base, head }: { base: ReviewRef; head: ReviewRef }): ReactElement {
  return (
    <div className="flex min-h-0 flex-col">
      <ReviewRangeHeading base={base} head={head} />
      <p className="px-2 pb-3 text-xs text-text-muted">
        This review carries a frozen patch, so its diff can’t be narrowed to individual commits.
      </p>
    </div>
  );
}

/** The review-scoped selector: fixed endpoints and, for a refs review, a brushable
 * subset of the review's own commits. Deliberately offers no branch/other-diff
 * escape — a review session stays on its review; the repo is opened separately to
 * explore freely. */
function ReviewSelectionPanel(): ReactElement | null {
  const source = useReviewStore((state) => selectActiveSlice(state)?.reviewOrigin?.source ?? null);
  const frozen = useReviewStore(
    (state) => selectActiveSlice(state)?.reviewDiff?.kind === "frozenPatch",
  );

  if (source === null || source.kind !== "local") {
    return null;
  }
  return (
    <section aria-label="Review diff" className="flex min-h-0 flex-1 flex-col gap-2 px-3 pt-3 pb-2">
      {frozen ? (
        <FrozenReviewNote base={source.base} head={source.head} />
      ) : (
        <ReviewCommitsSection base={source.base} head={source.head} />
      )}
    </section>
  );
}

/** The selection surface — one of the two modal sidebar views (SidebarNav). A
 * review session gets the review-scoped selector; a repo session gets the full
 * mode switch plus the active mode's source list. */
export function SelectionPanel(): ReactElement | null {
  const mode = useReviewStore((state) => selectActiveSlice(state)?.mode ?? null);
  const isReview = useReviewStore((state) => selectActiveSlice(state)?.reviewOrigin != null);

  if (mode === null) {
    return null;
  }
  if (isReview) {
    return <ReviewSelectionPanel />;
  }
  return (
    <section
      aria-label="Diff selection"
      className="flex min-h-0 flex-1 flex-col gap-2 px-3 pt-3 pb-2"
    >
      <ModeSwitch mode={mode} />
      {mode === "commits" ? (
        <CommitsSection />
      ) : mode === "branches" ? (
        <BranchesSection />
      ) : (
        assertNever(mode)
      )}
    </section>
  );
}
