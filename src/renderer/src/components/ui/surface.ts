/** The kit's floating surface: what a menu, a listbox, or a find bar is made of.
 *
 * An opaque slab, which is the right answer for everything that appears, is read, and is gone
 * again — the counterpart to the glass in `Glass.tsx` / `index.css`, which is reserved for the
 * surfaces whose whole point is that the reader's work stays visible behind them.
 *
 * The edge is a hairline `ring-foreground/10` rather than `border-border`: the border tone is
 * mixed for resting chrome and on the dark themes it is a near-invisible grey, which left a
 * panel with no silhouette against the diff. A ring also costs no layout, so a surface can be
 * given an edge without every child inside it shifting a pixel.
 *
 * Padding, width and the enter/exit animation belong to the caller — they are what the three
 * surfaces actually differ in. */
export const POPOVER_SURFACE =
  "rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10";
