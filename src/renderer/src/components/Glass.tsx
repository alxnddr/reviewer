// The class names that go on the app's frosted-glass surface; the surface itself is in
// index.css under `[data-glass]`. Two surfaces wear it — the overview's action island and
// the comment stepper — and they are the app's only controls that float over the reader's
// content for as long as they are working rather than appearing and going away. That is the
// rule for when glass is the right answer: a transient overlay can afford to be an opaque
// slab because it is gone in a moment; a persistent one would be a hole in the page.
//
// This file used to also export an SVG `feDisplacementMap` filter for the panel to reference
// from `backdrop-filter: url(#…)`, giving the glass real refraction rather than a flat blur.
// Chromium does not implement that: it accepts the value and then paints the entire chain as
// a no-op, blur included. The refraction is gone and the blur works.

/** What a control on glass wears instead of the ghost variant's own hover.
 *
 * The variant fills with `bg-muted`, which is opaque — on a translucent surface it kills the
 * blur under exactly the patch the pointer is on, so the panel appears to spring a leak
 * wherever you point at it. A wash off `foreground` tints the glass instead of covering it.
 * The `dark:` twins are required: the variant carries its own dark hover arm, and without
 * them it wins the cascade. */
export const GLASS_ACTION =
  "hover:bg-foreground/8 dark:hover:bg-foreground/10 focus-visible:ring-foreground/25";

/** The one thing on a glass surface the reader is meant to reach for. Full ink at 500 —
 * hierarchy here is weight, never fill: the app's saturated accent parked permanently over
 * a reading column is a lozenge in the corner of the eye on every line. */
export const GLASS_PRIMARY = `${GLASS_ACTION} font-medium text-foreground hover:text-foreground`;

/** Everything else on it. */
export const GLASS_MUTED = `${GLASS_ACTION} text-text-muted hover:text-foreground`;

/** The divider between two kinds of action on one pill. Off `foreground`, not `border` —
 * the border tone is mixed for opaque chrome and disappears against glass. */
export const GLASS_DIVIDER = "mx-1 h-4 w-px shrink-0 bg-foreground/15";
