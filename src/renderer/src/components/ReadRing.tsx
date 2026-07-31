import type { ReactElement } from "react";
import { countLabel } from "../../../shared/plural";
import { cn } from "@/lib/utils";
import type { ReadTally } from "@/lib/read-progress";

// How far through a *set* of files someone is, in one 12px glyph. It appears wherever the
// app names an aggregate — a chapter's row in the rail, the chapter band, a section of the
// doc, the tree's status line — so the shape of the answer is the same everywhere and only
// the sentence beside it changes.
//
// The app's two progress marks divide cleanly, and the division is the whole of what a
// reader has to learn: **a square checkbox is one file** (the diff header's own control,
// binary, ticked by hand) and **a round mark is a set of them** (derived, never authored,
// and quantitative until it is finished). Nothing else in the shell is round-and-ticked,
// so the two never trade places.
//
// Three states, one box:
//   nothing read — a bare track. Only ever drawn where the glyph is a *control* and has to
//                  be present to be clicked; a status readout renders no glyph at all
//                  rather than a column of empty circles down an untouched rail.
//   partly read  — an arc around that track, clockwise from twelve o'clock. It costs
//                  nothing over a plain "in progress" dot and answers "how much" too.
//   fully read   — a check. Completion is the one state that should need no second
//                  reading, and a closed ring reads as a circle, not as a finish.
//
// Neutral ink throughout: the shell reserves accent for the primary action and the diff
// colours for additions and deletions, so a third hue here would make progress shout over
// the code it is measuring. Fullness and shape carry it instead.

const SIZE = 12;
const CENTER = SIZE / 2;
const RADIUS = 4.4;
const STROKE = 1.6;

/** The arc for `fraction` of a turn, swept clockwise from twelve o'clock — the direction a
 * clock face has already taught everyone to read.
 *
 * Stroked along the track rather than filled in from the middle. A filled wedge is the
 * other obvious way to draw this and it is the wrong one here: at half-full it is a disc
 * with half its area dark, which is precisely the shell's own appearance toggle sitting in
 * the title bar a few hundred pixels away. Two unrelated meanings must not share a
 * silhouette on one screen. The stroked arc is also simply the idiom — it is what a
 * progress ring looks like everywhere else.
 *
 * Only ever called for a strictly partial fraction: a full turn degenerates to a
 * zero-length arc, which is one more reason the finished state is its own glyph. */
function arcPath(fraction: number): string {
  const angle = fraction * 2 * Math.PI;
  const x = CENTER + RADIUS * Math.sin(angle);
  const y = CENTER - RADIUS * Math.cos(angle);
  const largeArc = fraction > 0.5 ? 1 : 0;
  return `M ${CENTER} ${CENTER - RADIUS} A ${RADIUS} ${RADIUS} 0 ${largeArc} 1 ${x} ${y}`;
}

type ReadRingProps = {
  tally: ReadTally;
  /** What a screen reader hears in place of the glyph. The visible label beside it usually
   * says the same thing, in which case leave this null and let the text speak. */
  label?: string | null;
  className?: string;
};

/** Nothing to read is not zero progress — it is no progress bar at all. A file set the
 * loaded diff does not carry (a drifted chapter) renders nothing rather than an empty ring
 * implying work that is waiting. */
export function ReadRing({ tally, label = null, className }: ReadRingProps): ReactElement | null {
  if (tally.total === 0) {
    return null;
  }
  const fraction = tally.read / tally.total;
  const complete = tally.read === tally.total;

  return (
    <svg
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      aria-hidden={label === null ? true : undefined}
      role={label === null ? undefined : "img"}
      aria-label={label ?? undefined}
      className={cn(
        "size-3 shrink-0",
        // Untouched, the glyph sits at the faint register a row's other metadata does; the
        // moment it carries anything it steps up, and full ink is the finish.
        complete ? "text-foreground" : fraction > 0 ? "text-text-muted" : "text-text-faint",
        className,
      )}
    >
      {complete ? (
        // Drawn here rather than borrowed from the icon set so every state shares one
        // 12px box: a check that measured differently from the pie would make a rail row
        // twitch sideways at the moment it was finished.
        <path
          d={`M 2.5 6.4 L 4.9 8.8 L 9.5 3.4`}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.75}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : (
        <>
          <circle
            cx={CENTER}
            cy={CENTER}
            r={RADIUS}
            fill="none"
            stroke="currentColor"
            strokeWidth={STROKE}
            opacity={0.3}
          />
          {fraction > 0 && (
            <path
              d={arcPath(fraction)}
              fill="none"
              stroke="currentColor"
              strokeWidth={STROKE}
              strokeLinecap="round"
            />
          )}
        </>
      )}
    </svg>
  );
}

/** The sentence that goes with the glyph, in one voice everywhere it is printed. */
export function readLabel(tally: ReadTally): string {
  return `${tally.read} of ${countLabel(tally.total, "file")} read`;
}
