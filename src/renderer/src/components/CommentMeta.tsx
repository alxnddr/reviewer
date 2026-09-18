import { type ReactElement } from "react";
import { type Comment, type CommentSeverity, reservedTag } from "../../../shared/review";
import { cn } from "@/lib/utils";
import { PILL } from "@/components/ui/pill";

// The authored vocabulary a comment can carry, drawn once for every surface that shows a
// comment: the card in the diff and the row in the rail. One module rather than a pill per
// surface, because the two are read against each other — a reader scans the rail for the
// blocking findings and then looks at the card for one of them, and a tone that meant
// "blocking" in the column has to mean it on the card.
//
// Two fields, two different kinds of thing, and the split is the whole point:
//
// - `severity` is a closed enum (`shared/review.ts`), so the app may colour it. Three
//   levels, three tones already in the ramp — `--destructive` is what the app uses for the
//   irreversible, `--warning` for drift, and muted ink for everything it will not raise its
//   voice about. No new token: `design/README.md` is emphatic that the palette is
//   hand-maintained, and three findings' worth of chrome does not earn a fourth hue.
// - `tag` is free text, so it gets exactly one style whatever it says. Colouring a label by
//   what it appears to mean would be the app claiming to understand a vocabulary it has
//   never seen; the README's promise is that `rvw` has no opinion about what a bug is.
//
// The one exception is the three reserved words (`reservedTag`), and it is a stance, not a
// weight: `pre-existing`, `decision` and `question` say where a comment came from rather
// than how much it matters, so they are drawn *quieter* than a label the author invented.
// That is the entire extent of the app's opinion, and it lives in one `reservedTag` call.

/** Severity → its tone. A `switch` with no `default`, so a fourth level added to the enum
 * is a compile error here rather than an unstyled pill nobody notices (the closed-union
 * rule, `CLAUDE.md`). */
function severityTone(severity: CommentSeverity): string {
  switch (severity) {
    case "blocking":
      return "bg-destructive/10 text-destructive";
    case "important":
      return "bg-warning/10 text-warning";
    case "minor":
      return "bg-border/60 text-text-muted";
  }
}

export function SeverityPill({ severity }: { severity: CommentSeverity }): ReactElement {
  return <span className={cn(PILL, "font-medium", severityTone(severity))}>{severity}</span>;
}

/** A tag, as the author wrote it — never lower-cased or title-cased on the way out, because
 * the value is theirs and the schema already caps its length at what a pill can hold.
 *
 * Outlined where a severity is filled, and that is the two axes drawn as two shapes: a
 * filled pill is a level from a closed set the app understands, an outlined one is a label
 * it is only repeating. Without that split `minor` and a grey free tag beside it were the
 * same object twice, which is exactly the conflation `tag` and `severity` exist apart to
 * avoid — it was the first thing looking at the screen showed. A reserved word then drops
 * one step of ink again, because stance is the quietest thing a comment can say. */
export function TagPill({ tag }: { tag: string }): ReactElement {
  return (
    <span
      className={cn(
        PILL,
        "max-w-32 truncate ring-1 ring-border ring-inset",
        reservedTag(tag) === null ? "text-text-muted" : "text-text-faint",
      )}
    >
      {tag}
    </span>
  );
}

/** Both pills, in the fixed order severity-then-tag: the axis before the label, the same
 * order both exports write them in. Null when the comment carries neither — a review that
 * uses no vocabulary renders exactly as it did before this existed, with no empty pill and
 * no reserved space. */
export function CommentMeta({
  comment,
  className,
}: {
  comment: Pick<Comment, "severity" | "tag">;
  className?: string;
}): ReactElement | null {
  if (comment.severity === undefined && comment.tag === undefined) {
    return null;
  }
  return (
    <span className={cn("flex min-w-0 shrink-0 items-center gap-1", className)}>
      {comment.severity !== undefined && <SeverityPill severity={comment.severity} />}
      {comment.tag !== undefined && <TagPill tag={comment.tag} />}
    </span>
  );
}

/** The same two values as a sentence, for a place with no room to draw them — the rail
 * row's hover hint, which already carries the body in full. Null on a comment with
 * neither, so the hint gains no empty line. */
export function commentMetaLabel(comment: Pick<Comment, "severity" | "tag">): string | null {
  const parts = [comment.severity, comment.tag].filter((part) => part !== undefined);
  return parts.length === 0 ? null : parts.join(" · ");
}
