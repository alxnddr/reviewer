/** Which device drove the last interaction, mirrored onto `<html data-input-modality>`.
 *
 * The shell's own controls all use `:focus-visible`, which the browser already gates on
 * modality. The file tree cannot: `@pierre/trees` paints its focus ring from inside a
 * shadow root, on whichever row holds DOM focus — a clicked row included — and document
 * CSS cannot reach that rule. Custom properties DO inherit through the shadow boundary,
 * so the ring's colour is gated on this attribute instead (see `index.css`): after a
 * click the ring is transparent, because the selection fill already says which file is
 * open; the first key press brings it back, because that is when the ring is the only
 * thing saying where the next keystroke lands.
 *
 * Starts as `keyboard` — the safe default, since it hides nothing — and only ever
 * switches on real input.
 */
export function initInputModality(): void {
  const set = (modality: "pointer" | "keyboard"): void => {
    document.documentElement.dataset["inputModality"] = modality;
  };
  set("keyboard");
  // Capture, so the attribute is already current when the tree's own row handlers run on
  // the same event and the ring repaints in the same frame as the move it belongs to.
  window.addEventListener("pointerdown", () => set("pointer"), { capture: true });
  window.addEventListener(
    "keydown",
    (event) => {
      // A chord modifier is not navigation: ⌘-clicking, or holding ⌘ before ⌘O, must not
      // light the ring up. Only unmodified keys — j/k, the arrows, tab, typing — do.
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      set("keyboard");
    },
    { capture: true },
  );
}
