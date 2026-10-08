import type { CSSProperties, ReactElement, ReactNode } from "react";
import type { AnchorSpan } from "../../../../shared/review";
import type { AnchorDoor, ChapterBadge } from "@/lib/guide";
import { anchorLabel } from "@/lib/guide";
import { TooltipHint } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// How a guide element reaches the code it points at. Every visual node, skeleton line, changed
// symbol and map tile is a door into the diff, and they all go through **one** store action —
// `focusReference`, the door a `[label](path:12-20)` chip in the prose already uses — handed in
// from the screen that reads the store (the rail rule: sections read the store, rows take
// props). So following a box in a diagram is exactly following a reference: it leaves the
// document through `leaveDoc`, which starts the trip the "Back to overview" pill serves, and it
// lands on the anchor's line, unfolding the file if the reader had folded it.
//
// `paths` is what the surface can navigate to: the whole diff on the overview, the soloed
// chapter in the band above the diff. An element whose file is not in it is drawn, but inert —
// the same rule the prose chips follow (`Markdown`'s `ProseLinks`), so a click never lands on a
// file the surface is hiding.

export type { AnchorDoor } from "@/lib/guide";

/** Whether `anchor` can be followed on this surface. */
export function canOpen(door: AnchorDoor, anchor: AnchorSpan | undefined): anchor is AnchorSpan {
  return anchor !== undefined && door.paths.has(anchor.file);
}

/** The hint an element carries: its note, then where it points — chapter and `file:lines`. */
export function elementHint(
  note: string | undefined,
  anchor: AnchorSpan | undefined,
  badge: ChapterBadge | null,
): ReactNode {
  if (note === undefined && anchor === undefined) {
    return null;
  }
  return (
    <span className="flex flex-col gap-0.5">
      {note !== undefined && <span>{note}</span>}
      {anchor !== undefined && (
        <span className="font-mono text-[11px] opacity-75">
          {badge === null ? "" : `chapter ${badge.ordinal} · `}
          {anchorLabel(anchor)}
        </span>
      )}
    </span>
  );
}

type AnchorTargetProps = {
  door: AnchorDoor;
  anchor: AnchorSpan | undefined;
  hint: ReactNode;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
  /** Accessible name for the button; the visible text otherwise. */
  label?: string | undefined;
};

/** An element that opens its anchor when it can, and is a plain box when it cannot. A real
 * `<button>`, so Tab reaches it and Enter/Space follow it like every other door in the app. */
export function AnchorTarget({
  door,
  anchor,
  hint,
  className,
  style,
  children,
  label,
}: AnchorTargetProps): ReactElement {
  const element = canOpen(door, anchor) ? (
    <button
      type="button"
      aria-label={label}
      onClick={() => door.open(anchor)}
      style={style}
      className={cn(
        "cursor-pointer text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      {children}
    </button>
  ) : (
    <div style={style} className={className}>
      {children}
    </div>
  );
  return (
    <TooltipHint content={hint} side="top" align="start">
      {element}
    </TooltipHint>
  );
}

/** The face the guide sets *real code* in — a hunk card's lines: the mono stack, with the
 * reader's own ligature choice (`--diffs-font-features`, from the diff-ligatures setting) — so
 * `=>` in a hunk card reads exactly as it does in the diff a click away, and a `===` is never a
 * glyph the reader has turned off everywhere else. The pictures use `VISUAL_CODE_FACE`. */
export const CODE_FACE = "font-mono [font-feature-settings:var(--diffs-font-features)]";

/** The face the guide's *pictures* set code in — flow boxes, skeleton lines, the Shape tab's
 * signatures, the symbol chips — the mono stack with ligatures off whatever the reader chose.
 * Unlike a hunk card (`CODE_FACE`), none of that text is the diff: it is a signature quoted at
 * 12–13 px inside a figure, and there Geist Mono's joins read as symbols the source does not
 * contain — `kind !== "file"` became one wide bar, `=>` a long arrow, beside an ordinary `(`.
 * The setting's own argument for off ("a ligature can hide which character changed") is
 * stronger in a picture whose whole job is to say what changed, and nothing one click away has
 * to match it glyph for glyph: the click lands in the diff, which follows the setting. The same
 * call `PullRequestDialog`'s prompt and the settings' template field already make. */
export const VISUAL_CODE_FACE = "font-mono [font-variant-ligatures:none]";
