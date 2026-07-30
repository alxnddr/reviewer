import type { ReactElement } from "react";
import { FileWarning, Layers, MessageSquare, PackageCheck } from "lucide-react";
import type { RecentReview } from "../../../shared/recent-reviews";
import { ReadRing } from "@/components/ReadRing";
import { recentRange, recentTitle, showsRange } from "@/lib/recent-reviews";
import { absoluteTime, shortAge } from "@/lib/relative-time";
import { cn } from "@/lib/utils";

// One review, two lines: what the change is, then which change it is. Line one is read, line
// two is checked — the same division the commit rows in the rail make.
//
// It lives on its own because two surfaces list reviews and they must not drift: the recents
// picker (⇧⌘R), where rows are options in a virtualized listbox, and the start screen's
// history, where each row is a button in a flow-laid document. Those differ in every way a
// row *container* can differ — height, positioning, role, what the keyboard does — and not at
// all in what a row says. So the container stays with each list and the content is here.

/** The badges a row carries after its range, all of them conditional and none of them
 * decoration: a count the reader is choosing between reviews by, or a fact that predicts what
 * clicking will do. */
function Meta({ icon, children }: { icon: ReactElement; children: number }): ReactElement {
  return (
    <span className="flex shrink-0 items-center gap-1 tabular-nums">
      {icon}
      {children}
    </span>
  );
}

export function RecentReviewLines({
  review,
  now,
}: {
  review: RecentReview;
  /** Coarse clock, passed in rather than read, so a list of rows re-ages in one tick. */
  now: Date;
}): ReactElement {
  const summary = review.summary;
  return (
    <>
      <span className="flex w-full min-w-0 items-baseline gap-3">
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">
          {recentTitle(review)}
        </span>
        {/* The age, right-aligned into its own column, with the date behind it on hover: "3d"
            is what a list is scanned by and the wrong answer to "which day was that". */}
        <span
          className="shrink-0 text-xs tabular-nums text-text-faint"
          title={absoluteTime(review.modified)}
        >
          {shortAge(review.modified, now)}
        </span>
      </span>
      <span className="flex w-full min-w-0 items-center gap-2 text-xs text-text-muted">
        {summary === null ? (
          <span className="flex items-center gap-1.5 text-text-faint">
            <FileWarning aria-hidden="true" className="size-3.5 shrink-0" />
            Not a readable review
          </span>
        ) : (
          <>
            <span className="shrink-0 font-medium text-text-muted">{summary.repoName}</span>
            {/* Absent when the line above already *is* the range — an untitled review would
                otherwise print its endpoints twice, once as its name and once as its
                subtitle. */}
            {showsRange(review) && (
              <>
                <span aria-hidden="true" className="text-text-faint">
                  ·
                </span>
                <span className="min-w-0 truncate font-mono">{recentRange(summary)}</span>
              </>
            )}
            {summary.comments > 0 && (
              <Meta icon={<MessageSquare aria-hidden="true" className="size-3 shrink-0" />}>
                {summary.comments}
              </Meta>
            )}
            {summary.layers > 0 && (
              <Meta icon={<Layers aria-hidden="true" className="size-3 shrink-0" />}>
                {summary.layers}
              </Meta>
            )}
            {/* The one badge on the row, and it earns its place by predicting the click:
                a refs-only review of a repo that has since moved will not open, and this
                is the artifact that opens anywhere. */}
            {summary.portable && (
              <span
                title="Carries its own diff — opens without the repo"
                className="ml-auto flex shrink-0 items-center gap-1 rounded-full bg-foreground/8 px-1.5 py-0.5 text-[11px] text-text-muted dark:bg-foreground/12"
              >
                <PackageCheck aria-hidden="true" className="size-3" />
                self-contained
              </span>
            )}
            <Progress progress={review.progress} pushed={!summary.portable} />
          </>
        )}
      </span>
    </>
  );
}

/** How far into this review its reader got, on the end of the metadata line — the counts and
 * the same ring the rail and the chapter bands use, so "how far through" looks the same
 * everywhere in the app and only the set it is counting changes.
 *
 * Nothing at all for a review nobody has started, which is the common case and the reason
 * this reads as a *resume* mark rather than a status column: a row that carries one is a row
 * with something to come back to.
 *
 * The counts are printed, never a lone percentage. This denominator is the file count from
 * the last time the reader marked something, not from the diff as it stands now — main has no
 * diff in hand while listing a directory — so "12/30" is the honest shape of a remembered
 * answer in a way "40%" is not. */
function Progress({
  progress,
  pushed,
}: {
  progress: RecentReview["progress"];
  /** Whether this has to do the `ml-auto` itself, because no self-contained badge came
   * before it to push the pair to the end of the line. */
  pushed: boolean;
}): ReactElement | null {
  if (progress === null) {
    return null;
  }
  const done = progress.total > 0 && progress.read >= progress.total;
  return (
    <span
      title={done ? "You finished this review" : "Where you left off"}
      className={cn(
        "flex shrink-0 items-center gap-1.5 tabular-nums text-text-muted",
        pushed && "ml-auto",
      )}
    >
      <ReadRing tally={{ read: progress.read, total: progress.total }} />
      {/* A total of zero means marks were made against a diff whose size was never
          recorded — an older record, or one written before the diff finished loading. The
          count alone is still true and still useful; a "12/0" would not be. */}
      {progress.total === 0 ? `${progress.read} read` : `${progress.read}/${progress.total}`}
    </span>
  );
}
