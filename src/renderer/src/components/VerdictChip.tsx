import type { ReactElement } from "react";
import type { ReviewVerdict } from "../../../shared/review";
import { cn } from "@/lib/utils";
import { PILL } from "@/components/ui/pill";

// The author's claim about whether the change should land, drawn the same way in the two
// places a review is met: on the tour doc's title, and on a picker row before the review is
// opened at all. One module for the same reason `CommentMeta` is one — a reader picks a
// review off the recents list by its verdict and then sees the same word at the top of the
// doc, and a chip that changed shape between those two would read as a different claim.
//
// Three tones out of the ramp the app already has, no new token (`design/README.md` is
// emphatic that the palette is hand-maintained, and one chip does not earn a hue): the diff's
// own green is the app's affirmative ink wherever it is not counting lines — the copied tick
// on the prompt button, the onboarding checklist — `--warning` is what drift is drawn in, and
// `--destructive` is what it reserves for the thing you cannot walk back.
//
// The word is printed as the author wrote it, lower case, exactly like `SeverityPill`: both
// are a value out of a closed enum in the artifact, and title-casing one would turn the
// author's word into the app's. The chapter chips beside it (`Skim`, `Outdated`) are
// capitalised because those *are* the app's words about a layer.

/** Verdict → its tone. A `switch` with no `default`, so a fourth verdict added to the enum is
 * a compile error here rather than an unstyled chip nobody notices (the closed-union rule,
 * `CLAUDE.md`). */
function verdictTone(verdict: ReviewVerdict): string {
  switch (verdict) {
    case "ready":
      return "bg-diff-add-fg/10 text-diff-add-fg";
    case "caution":
      return "bg-warning/10 text-warning";
    case "blocked":
      return "bg-destructive/10 text-destructive";
  }
}

export function VerdictChip({
  verdict,
  className,
}: {
  verdict: ReviewVerdict;
  className?: string;
}): ReactElement {
  return (
    <span className={cn(PILL, "font-medium", verdictTone(verdict), className)}>{verdict}</span>
  );
}
