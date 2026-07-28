import type { ReactElement } from "react";
import { cn } from "@/lib/utils";

// What the app's two glass surfaces float over when there is no review yet: the first-run
// guide, and the empty state that succeeds it.
//
// Glass needs something behind it or it is just a pale rectangle: the blur and the saturate
// are entirely about what they are blurring, and on a blank page they produce nothing. The
// app's own answer to "what is behind the glass" is always the diff, so that is what this
// paints — a diff at reading distance and out of focus, close enough that the eye reads
// "code, with things added and removed" and far enough that there is nothing to try to read.
//
// It is drawn rather than sampled from a real diff on purpose: both surfaces stand where the
// reader has no repository open, so any real content would be a lie about their own work.

/** One line of the field: how far it is indented, how wide its run of "code" is (percent of
 * the column), and which band it sits in. */
type FieldLine = readonly [indent: number, width: number, tone: "context" | "add" | "del"];

/** A plausible file rather than noise — signatures, bodies, three hunks of change, a tail.
 * Written out at the length that fills a tall window in one pass: anything shorter has to
 * repeat, and a tiled backdrop announces itself the moment the eye catches the seam. */
const FIELD: readonly FieldLine[] = [
  [0, 34, "context"],
  [0, 46, "context"],
  [1, 62, "context"],
  [1, 38, "context"],
  [2, 54, "context"],
  [2, 31, "del"],
  [2, 44, "del"],
  [2, 49, "add"],
  [2, 36, "add"],
  [2, 58, "add"],
  [1, 27, "context"],
  [1, 40, "context"],
  [0, 18, "context"],
  [0, 12, "context"],
  [0, 51, "context"],
  [1, 43, "context"],
  [1, 66, "context"],
  [2, 39, "context"],
  [2, 47, "del"],
  [2, 55, "add"],
  [2, 32, "add"],
  [1, 33, "context"],
  [1, 60, "context"],
  [1, 24, "context"],
  [0, 22, "context"],
  [0, 15, "context"],
  [0, 57, "context"],
  [1, 41, "context"],
  [1, 50, "context"],
  [2, 64, "context"],
  [2, 29, "add"],
  [2, 45, "add"],
  [2, 38, "add"],
  [1, 37, "context"],
  [1, 52, "context"],
  [0, 25, "context"],
  [0, 19, "context"],
  [0, 48, "context"],
  [1, 59, "context"],
  [1, 34, "del"],
  [1, 42, "del"],
  [2, 56, "context"],
  [2, 30, "context"],
  [2, 44, "context"],
  [1, 28, "context"],
  [1, 61, "context"],
  [0, 20, "context"],
  [0, 13, "context"],
  [0, 53, "context"],
  [1, 35, "context"],
  [1, 47, "add"],
  [1, 58, "add"],
  [2, 26, "context"],
  [2, 49, "context"],
  [2, 36, "context"],
  [2, 63, "context"],
  [1, 31, "del"],
  [1, 43, "context"],
  [0, 23, "context"],
  [0, 55, "context"],
  [1, 39, "context"],
  [1, 46, "context"],
  [2, 33, "context"],
  [2, 51, "context"],
  [1, 29, "context"],
  [0, 17, "context"],
];

const BAND: Record<FieldLine[2], string> = {
  context: "",
  add: "bg-diff-add-bg",
  del: "bg-diff-del-bg",
};

/** The bar itself takes the band's ink, so colour survives the blur even where the row's
 * fill is nearly gone. Context lines stay grey — a field where everything is tinted reads
 * as a pattern rather than as a change. */
const INK: Record<FieldLine[2], string> = {
  context: "bg-foreground/14",
  add: "bg-diff-add-fg/30",
  del: "bg-diff-del-fg/30",
};

/** Fills its positioned ancestor — the guide's full-window overlay, or the empty state's
 * pane. Purely decorative, and inert to the pointer. */
export function DiffField(): ReactElement {
  return (
    <div aria-hidden="true" className="absolute inset-0 overflow-hidden bg-background">
      {/* Two washes in the diff's own hues, wide and weak. They are what the glass's
          saturate has to bite on: without them the panel samples a grey page and comes out
          grey, and the whole effect collapses into a frosted card on a wall. */}
      <div className="absolute -top-1/4 -left-[5%] size-[45vw] rounded-full bg-diff-add-fg/10 blur-[120px]" />
      <div className="absolute -right-[5%] -bottom-1/4 size-[42vw] rounded-full bg-diff-del-fg/8 blur-[120px]" />
      {/* The field fades out well before the panel edges: a hard-edged wallpaper would draw
          a rectangle of its own around the card and start competing with it. */}
      <div className="absolute inset-0 [mask-image:radial-gradient(105%_90%_at_50%_45%,#000_12%,transparent_70%)]">
        {/* The rhythm is the whole illusion. At a line height anywhere near real code the
            rows read as code seen across a room; a few pixels taller and they stop being
            text and become stripes — which is what a "wall of lines" background always
            looks like when it is drawn for decoration rather than measured against type. */}
        {/* A column, not a wall. Full-bleed rows put a tinted band edge to edge across the
            window and the field stops reading as code and starts reading as stripes; held to
            a document's width it is a file open behind the card, which is the thing the
            reader is about to spend their time in. */}
        <div className="mx-auto flex min-h-full w-[min(60rem,88%)] flex-col justify-center gap-[2px] py-6 opacity-60 dark:opacity-45">
          {FIELD.map(([indent, width, tone], index) => (
            <div
              key={index}
              className={cn(
                "flex h-2.5 shrink-0 items-center rounded-[2px] px-2",
                tone !== "context" && BAND[tone],
              )}
            >
              <span
                className={cn("h-[3px] rounded-full", INK[tone])}
                style={{ marginLeft: `${indent * 1.1}rem`, width: `${width}%` }}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
