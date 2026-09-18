// The pill shape, once. Three surfaces draw one — a comment's severity, a comment's tag
// (`CommentMeta.tsx`) and the overview's verdict (`VerdictChip.tsx`) — and they are read
// against each other on the same screens, so the shape has to be one declaration rather than
// three copies of the same six utilities drifting a padding step apart.
//
// Only the *shape* is shared. What each pill means, and therefore what tone it takes, stays
// with the thing it labels: a severity is an axis the app understands, a tag is a label it is
// only repeating, a verdict is the author's claim about the whole change.

/** Small caps-height chrome that sits on one line beside 13–14px text without changing the
 * line box — `leading-none` plus symmetric padding, so a row that gains a pill does not get
 * taller. */
export const PILL = "inline-flex shrink-0 items-center rounded px-1 py-0.5 text-xs leading-none";
