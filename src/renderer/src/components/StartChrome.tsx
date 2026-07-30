import type { ReactElement, ReactNode } from "react";

// The start screen's shared chrome: the heading its sections are named by, the inset everything
// on it is aligned to, and the hairline between regions. All three are here rather than in either
// component because the screen and its review list each own one region and both regions have to
// look like the same page.

/** The inset every *text* line on this screen shares.
 *
 * It exists because one element on the page cannot give it up: a review row is a click target,
 * so it carries horizontal padding for its hover fill to sit in, which pushes its text 10px in
 * from the reading column's edge. Everything else was flush to that edge — the two headings, the
 * prompt, the search field and its glyph, the rules — so every line on the screen was a hair
 * wider than the rows it was about, which is the kind of misalignment you feel before you can
 * name it.
 *
 * So the rows keep their padding and everything else matches it. What that costs is that the
 * rules cannot be drawn on the padded boxes (a border spans the padding, not the text) — hence
 * `StartRule`, which draws its own line at the same inset. The only thing left wider than the
 * text is a row's hover fill, which is what a hover fill is for. */
export const START_INSET = "px-2.5";

/** The line between two regions of the screen, inset to the text like everything else.
 *
 * Also inset from the *window*: it is held to the reading column rather than run edge to edge,
 * because a full-bleed rule across a window this wide is a much louder object than the boundary
 * it marks. Held to the column it reads as the document rhythm the tour doc uses. */
export function StartRule(): ReactElement {
  return <div aria-hidden="true" className="mx-2.5 border-t border-foreground/8" />;
}

/** A section name — "Ask your agent for a review", "Recent reviews".
 *
 * The screen has exactly two things on it and it used to say so in a sentence, which is the
 * wrong grammar for a landing surface: a line of prose across the top reads as something to be
 * read, sits at the same weight as everything under it, and leaves the two halves of the page
 * looking like one undivided column. Two headings in one register do the naming and the
 * dividing at once, and cost a word each.
 *
 * 16px at 500 — one clear step above the 14px rows it names, and one step below the tour doc's
 * 18px chapter headings. Both bounds matter: at the rows' own size it read as another row, and at
 * the doc's size it would be the loudest thing on a screen whose content is the list. */
export function StartHeading({ children }: { children: ReactNode }): ReactElement {
  return <h2 className="text-base leading-6 font-medium text-foreground">{children}</h2>;
}
