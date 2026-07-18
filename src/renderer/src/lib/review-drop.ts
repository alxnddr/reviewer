// The drop policy, pure so its load-bearing invariant — a file drag is always
// preventDefault'd — is tested without a renderer. Without the preventDefault,
// Electron navigates the window to the dropped `file://`, which `will-navigate`
// (window.ts) treats as hostile; intercepting here is what keeps the drop a
// review-open and not a navigation.

/** The minimal structural view of a drag event the policy needs; a DOM
 * `DragEvent`/React `DragEvent` satisfies it. */
export type DragLike = {
  preventDefault: () => void;
  dataTransfer: {
    types: readonly string[];
    files: ArrayLike<File>;
  };
};

/** The drag payload's carried-type list — the only field the file/text
 * discrimination reads. */
export type DragTypes = Pick<DragLike["dataTransfer"], "types">;

/** A file drag (vs a text/element drag inside the app, which passes through). */
export function isFileDrag(dataTransfer: DragTypes): boolean {
  return dataTransfer.types.includes("Files");
}

/** dragenter/dragover on a file drag: claim it (preventDefault) so the browser
 * neither navigates nor blocks the eventual drop. Returns whether it was a file
 * drag, so the caller can drive the drop-target affordance. A non-file drag is
 * left untouched. */
export function claimFileDrag(event: DragLike): boolean {
  if (!isFileDrag(event.dataTransfer)) {
    return false;
  }
  event.preventDefault();
  return true;
}

/** drop: always preventDefault (the navigation guard), then hand back the first
 * dropped file, or null when the drop carried none. */
export function takeDroppedFile(event: DragLike): File | null {
  event.preventDefault();
  return event.dataTransfer.files[0] ?? null;
}
