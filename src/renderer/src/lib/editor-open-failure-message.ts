import { assertNever } from "../../../shared/assert";
import type { EditorOpenFailure } from "../../../shared/editor-ipc";

/** The sentence for each way Open in Editor can refuse (`shared/editor-ipc.ts`). Composed here,
 * at the edge that shows it, the way `review-open-failure-message.ts` does — the code crosses
 * the wire, the prose does not. Each one says what to do next, because every refusal here is
 * one the reader can answer. */
export function editorOpenFailureMessage(failure: EditorOpenFailure): string {
  switch (failure.code) {
    case "noSession":
      return "That tab is no longer open.";
    case "notLive":
      return "This review is reading its own copy of the diff, so there is no checkout to open a file from. Locate the repository first.";
    case "noEditor":
      return "No editor is chosen. Pick one under Settings ▸ Editor.";
    case "outsideRepo":
      return "That path leads outside the repository, so it was not opened.";
    case "missing":
      return "That file is not on disk in this checkout — deleted by the change, or the checkout has moved on.";
    default:
      return assertNever(failure);
  }
}
