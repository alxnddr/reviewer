// Moving between the app's big regions without a pointer.
//
// The shell is three panes that each hold a long list — the layer tree, the file tree, the
// diff — and Tab walks *into* whichever one it reaches and then keeps walking, row by row,
// button by button. Getting from the diff back to the layer tree that way means tabbing
// past every comment card's toolbar in between. F6 is the convention for exactly this (it
// is what browsers, IDEs and every ARIA landmark guide use): one key that jumps to the next
// region and leaves the walking inside a region to the arrow keys, which each of these
// three already implements.
//
// Regions are resolved from the DOM by selector rather than held in a store. Every one of
// them is conditionally mounted — the layer tree only exists in a review, the diff only for
// a loaded one, the doc only while it is the reader's stop — so the list of what is
// reachable *right now* is a fact about the DOM, and a store mirroring it would be a second
// copy to keep in step with no way to be right when they disagreed.

/** The regions F6 walks, in the order it walks them: left to right, top to bottom, which is
 * the order they sit on screen. Each selector must match an element that is focusable and
 * owns its own keyboard handling once focused. */
const REGION_SELECTORS = [
  // The rail's diff picker, when it is open: the section bar is the entry point (the
  // commit listbox below it owns its own arrow keys once tabbed into), and it is also
  // the way back out of the picker, which is exactly what a reader who arrived here
  // without a pointer needs to reach.
  // (`:not(:disabled)` — with no diff loaded the bar is held open and inert, so there
  // is no second state for it to take and nothing for focus to do on it.)
  "[data-diff-section][aria-expanded='true']:not(:disabled)",
  // The rail's walkthrough — a real `tree` widget with arrow-key stepping.
  '[role="tree"][aria-label="Layers"]',
  // The rail's comment overview: its rows are buttons, so the region entry point is the
  // disclosure bar and Tab takes it from there.
  "[data-comments-panel]",
  // The file tree's filter field. The tree *rows* below it are not reachable — Pierre's
  // FileTree renders no focus stop of its own — so the field is the whole of what this
  // region can offer a keyboard: it filters the listing to one file, and j/k then step the
  // focused file from anywhere. Landing on a text input is also why F6 itself takes no
  // editable-target guard: it is the way back out of this field.
  "[data-file-tree] input",
  // The diff surface (DiffView sets this on Pierre's scroll container) or the overview
  // document, whichever is the current stop — never both, so one selector each is enough.
  '[role="region"][aria-label="Diff"]',
  "[data-overview-doc]",
  // The start screen's review list, which is the only region that screen has: the rest of it
  // is a two-line header and a footer of buttons, both of them ordinary Tab stops. Landing
  // here is what gives PgDn and the arrows the list to move.
  "[data-review-history]",
] as const;

/** Where in `regions` the focus currently sits — the region that *contains* the focused
 * element, not just the one that is it, so focus resting on a tree row or a comment row
 * still counts as being in that region and F6 moves on rather than back to the top.
 *
 * @internal Exported for its own unit test only — `nextRegion` is the one caller. */
export function activeRegionIndex(regions: readonly HTMLElement[], active: Element | null): number {
  if (active === null) {
    return -1;
  }
  return regions.findIndex((region) => region === active || region.contains(active));
}

/** The region F6 should land on next, or null when there is nothing to move to. Wraps, so
 * the key keeps working rather than dead-ending at the last pane; with focus outside every
 * region (the title bar, a dialog) it starts at the first, which is what a reader pressing
 * it from nowhere in particular means by it. */
export function nextRegion(
  regions: readonly HTMLElement[],
  active: Element | null,
  direction: 1 | -1,
): HTMLElement | null {
  if (regions.length === 0) {
    return null;
  }
  const index = activeRegionIndex(regions, active);
  if (index === -1) {
    return (direction === 1 ? regions[0] : regions.at(-1)) ?? null;
  }
  return regions[(index + direction + regions.length) % regions.length] ?? null;
}

/** The regions actually on screen, in walk order. Reads the DOM at press time: which panes
 * exist changes with the session, the loaded diff and the soloed layer. */
export function visibleRegions(root: ParentNode = document): HTMLElement[] {
  const found: HTMLElement[] = [];
  for (const selector of REGION_SELECTORS) {
    const element = root.querySelector<HTMLElement>(selector);
    // A region inside a collapsed panel is in the DOM but has no box; walking to it would
    // move focus somewhere invisible.
    if (element !== null && element.getClientRects().length > 0) {
      found.push(element);
    }
  }
  return found;
}
