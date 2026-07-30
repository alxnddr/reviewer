import type { RecentReview } from "../../../shared/recent-reviews";
import { shortRef } from "./refs";

// The recents list's own vocabulary: what a row is called, what a search runs against, and
// which rows a query keeps. Pure and headless so the picker's behaviour is proven without
// mounting it — the same posture as `layers.ts` and `overview.ts`.

/** The file's own name, for a row whose artifact could not be read and for the search
 * haystack. Everything in this list is an absolute path from main, so the last segment is the
 * filename; the extension is dropped because every single row carries it and a column of
 * repeated `.reviewer.json` is noise standing where the distinguishing part should be. */
export function recentFileName(path: string): string {
  const name = path.split("/").pop() ?? path;
  return name.endsWith(".reviewer.json") ? name.slice(0, -".reviewer.json".length) : name;
}

/** The range as chrome reads it: a branch verbatim, a 40-char sha down to 7. Shared with the
 * rail's own endpoint label (`shortRef`) rather than re-decided here, so a review named one
 * way in the picker is named the same way in the session it opens. */
export function recentRange(summary: NonNullable<RecentReview["summary"]>): string {
  return `${shortRef(summary.base)} → ${shortRef(summary.head)}`;
}

/** What the row says it is, in one line. The overview's title when the review has one —
 * someone wrote that sentence to name this change, and it beats anything derivable — else the
 * range, which every artifact has. An unreadable file falls back to its filename: it is all
 * that is known about it, and it is still enough to recognise. */
export function recentTitle(review: RecentReview): string {
  if (review.summary === null) {
    return recentFileName(review.path);
  }
  return review.summary.title ?? recentRange(review.summary);
}

/** Whether the second line still has a range to show — false exactly when the first line is
 * already the range, because the title fell back to it. Printing it twice is how the row for
 * an untitled review ended up saying `main → rewrite-guides` above `main → rewrite-guides`. */
export function showsRange(review: RecentReview): boolean {
  return review.summary !== null && review.summary.title !== null;
}

/** Everything a query is matched against, joined. The *filename*, not the path: every row in
 * this list comes out of one directory, so the shared prefix contributes nothing but false
 * matches — and under a subsequence matcher it contributes a lot of them, since almost any
 * short query is a subsequence of a long absolute path. Typing "api" matched all six rows
 * before this was narrowed. */
export function recentSearchText(review: RecentReview): string {
  const name = recentFileName(review.path);
  const summary = review.summary;
  if (summary === null) {
    return name;
  }
  return [summary.repoName, summary.base, summary.head, summary.title ?? "", name].join(" ");
}

/** The rows a query keeps, in the order they came — which is newest-first, and stays that way.
 * Deliberately not re-ranked by match quality: this list is read chronologically, and a filter
 * that also reorders means the row under the cursor moves for reasons the reader cannot see.
 * A blank query keeps everything.
 *
 * Every whitespace-separated word must appear somewhere in the row, as a **substring** — not
 * the subsequence match the file tree filters paths with (`fuzzyMatches`). Subsequence is right
 * for paths, where `srcbtn` usefully reaches `src/components/Button.tsx`; it is wrong here,
 * where the searchable text is mostly a prose title. Against prose, a three-letter query is a
 * subsequence of almost everything: typing `api` matched all six rows in the first run of this
 * — `m(a)in`, `(p)icker`, `rev(i)ews` — which is a filter that does nothing while looking like
 * it did something. Words are matched independently so `docs guides` finds a row that says
 * both without having to say them in that order. */
export function filterRecents(
  reviews: readonly RecentReview[],
  query: string,
): readonly RecentReview[] {
  const words = query
    .toLowerCase()
    .split(/\s+/u)
    .filter((word) => word.length > 0);
  if (words.length === 0) {
    return reviews;
  }
  return reviews.filter((review) => {
    const haystack = recentSearchText(review).toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

/** One heading and the rows under it, on the start screen's chronological list. */
export type RecentGroup = { label: string; reviews: RecentReview[] };

/** The bands the list is broken into, coarsest last. Calendar-relative rather than elapsed
 * hours: "yesterday" means the day before this one, not 24 hours ago, which is what the
 * reader means by it at nine in the morning. `days` is how far back from the start of today
 * the band reaches. */
const AGE_BANDS: readonly { label: string; days: number }[] = [
  { label: "Today", days: 0 },
  { label: "Yesterday", days: 1 },
  { label: "Previous 7 days", days: 7 },
  { label: "Previous 30 days", days: 30 },
];

/** The last band, which has no boundary — everything older falls into it. */
const OLDER = "Older";

const DAY_MS = 24 * 3600 * 1000;

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** The list broken into date bands, newest band first and rows inside each band in the order
 * they arrived — which is newest-first, and stays that way for the same reason the filter does
 * not re-rank.
 *
 * The start screen shows this list rather than a flat run of rows because it is read as a
 * history: the question a reader brings to it is "the one from this morning" or "the one from
 * last week", and a date column on every row makes them do the arithmetic themselves. Empty
 * bands are dropped, so a machine that has been reviewed on twice today shows one heading
 * rather than five.
 *
 * `now` is a parameter, like `shortAge`'s, so the banding is pure and testable. A row with an
 * unreadable mtime (never seen in practice — main reads it off the filesystem) sorts into
 * `Older` rather than throwing the whole list.
 *
 * The bands are deliberately *not* the picker's problem: it is a search field, where the
 * answer to "which one" is typed rather than scanned. */
export function groupRecents(reviews: readonly RecentReview[], now: Date): RecentGroup[] {
  const today = startOfDay(now);
  const groups = new Map<string, RecentReview[]>();
  for (const review of reviews) {
    const modified = new Date(review.modified).getTime();
    const band = Number.isNaN(modified)
      ? undefined
      : AGE_BANDS.find(({ days }) => modified >= today - days * DAY_MS);
    const label = band?.label ?? OLDER;
    groups.set(label, [...(groups.get(label) ?? []), review]);
  }
  return [...AGE_BANDS.map(({ label }) => label), OLDER]
    .map((label) => ({ label, reviews: groups.get(label) ?? [] }))
    .filter((group) => group.reviews.length > 0);
}

/** Where a keyboard step lands. Clamped rather than wrapped: this is a long list with a
 * scrollbar, not a three-item menu, and a ↓ at the bottom that silently teleports to the top
 * loses the reader's place. An empty list has no cursor, hence -1. */
export function stepIndex(current: number, delta: number, count: number): number {
  if (count === 0) {
    return -1;
  }
  return Math.min(Math.max(current + delta, 0), count - 1);
}
