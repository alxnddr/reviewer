import { create, type StoreApi, type UseBoundStore } from "zustand";
import type { EditorOpenFailure, EditorOpenRequest } from "../../../shared/editor-ipc";

// Open in Editor, renderer side: one action that asks main, and the one refusal it is
// showing. Its own store rather than a tenth review slice because nothing here belongs to a
// session — the request names one, but the banner that reports a refusal is app-level, like
// the open and export failures, and the controls that fire it (the file header, the E key, the
// title bar's repository button and the File-menu item beside it) should not each have to
// thread a callback through DiffScreen to reach a session action.
//
// One action for both halves rather than an `open` and an `openRepository`: what is being
// opened is a closed union on the request (`shared/editor-ipc.ts`), so a call site says which
// arm it means in the object it already builds, and the refusal, the banner and the sentence
// are the same for either. A second action would be a second place to forget the banner.
// There were three: a comment's hover toolbar carried the button as well, until the glyph's
// subject there (the comment) and its action (the file) were read as the disagreement they
// are. `E` still opens the focused *comment's* line — `lib/editor-target.ts` is what makes
// one key mean both — so the store's callers shrank and its reach did not.
//
// Every pre-check the renderer could make — frozen session, no editor chosen — is left to
// main, which has to make it anyway and answers with the same typed code. The button still
// reads those two facts to disable itself with a hint (`OpenInEditorButton`), but the E
// key does not, and a press that cannot be honoured is explained on the banner rather than
// swallowed.

type EditorState = {
  /** The last refusal, until dismissed or until a later open succeeds. */
  failure: EditorOpenFailure | null;
  open: (request: EditorOpenRequest) => Promise<void>;
  clearFailure: () => void;
};

export type EditorStore = UseBoundStore<StoreApi<EditorState>>;

/** A factory, like the settings store's, so a test builds its own instance around a stubbed
 * bridge; `useEditorStore` is the app's one. */
export function createEditorStore(): EditorStore {
  return create<EditorState>((set) => ({
    failure: null,
    open: async (request) => {
      const bridge = window.reviewer;
      if (!bridge) {
        return;
      }
      const response = await bridge.openInEditor(request);
      set({ failure: response.ok ? null : response.failure });
    },
    clearFailure: () => set({ failure: null }),
  }));
}

export const useEditorStore: EditorStore = createEditorStore();
