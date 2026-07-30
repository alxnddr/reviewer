// When a single-key shortcut is allowed to fire, in one place.
//
// The app hangs its letter keys — j/k, n/p, r, o — off `window`, because the surfaces they
// act on are spread across two screens and none of them is reliably the focused element. A
// window listener is the right shape for that, and it has one failure mode: it fires no
// matter what is on top. Every one of these handlers grew the same two guards independently
// (never with a modifier, never inside a text field), and none of them grew the third — so
// with the shortcut sheet open, `o` toggled the tour doc behind it and `r` marked a file read
// that the reader could not even see.
//
// Untested, like `visibleRegions` next door and for the same reason: every line of it is a
// DOM read, the suite runs in node with no DOM environment, and a stubbed `querySelector`
// would only be testing the stub.

/** Typing, in any of the three shapes the DOM offers. */
export function isEditable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
  );
}

/** Whether a modal sheet currently owns the screen. Read from the DOM rather than a store for
 * the same reason the focus regions are: the dialogs are mounted by three different owners
 * (the shortcut sheet, the recents picker, the kit's own), and a flag they all had to
 * remember to set is a flag one of them would forget. */
export function modalOpen(root: ParentNode = document): boolean {
  return root.querySelector('[role="dialog"][data-open], [role="alertdialog"][data-open]') !== null;
}

/** The whole guard for a plain letter shortcut: not a chord, not typing, not behind a sheet.
 *
 * Shift is deliberately *not* rejected — a shortcut whose key is only reachable with shift
 * (`?`) would never fire — so a handler that must not collide with a shifted character checks
 * `event.shiftKey` itself. */
export function shortcutBlocked(event: KeyboardEvent): boolean {
  return event.metaKey || event.ctrlKey || event.altKey || isEditable(event.target) || modalOpen();
}
