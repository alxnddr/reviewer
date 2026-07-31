import type { StateCreator } from "zustand";
import type { ReviewerBridge } from "../../../../shared/ipc";
import type { ReviewOrigin } from "../../../../shared/review";
import type { SessionId } from "../../../../shared/session";
import {
  exportSourceFor,
  markdownCommentsFrom,
  reviewToMarkdown,
  serializeReview,
} from "../../lib/review-export";
import type { ReviewExportFailure } from "../../lib/review-export-failure-message";
import { headShaOf, reviewFileBase } from "../../lib/session-projection";
import { withSlice, type SessionSlice } from "./slice";
import type { ReviewState } from "./state";

// The review as a file on disk, in either of the two shapes it can take. Both actions are the
// same three steps — work out what artifact this session even *is* (`resolveExportOrigin`),
// render it, hand it to main's native save seam — and both surface a lost write rather than
// letting the reviewer believe a curated review was saved when nothing reached disk.

export type ExportSlice = {
  /** A failed review export: app-level like the open failures, surfaced by
   * ReviewExportFailureBanner and cleared on the next export or dismissal. Either a
   * lost disk write (a swallowed one would leave the reviewer believing a curated
   * review was saved when nothing reached disk) or an unreadable diff that
   * could not be frozen into an artifact — never a silent no-op. */
  reviewExportFailure: ReviewExportFailure | null;
  /** Export the curated review as a round-trip `.reviewer.json`: serialize
   * the authored projection and hand it to the native save seam in main. An
   * imported review re-emits its authored source verbatim; a plain repo session
   * exports its on-screen diff (`resolveExportOrigin`) — branch refs, or a frozen
   * patch for a commit-range/working-tree diff. */
  exportReviewJson: (sessionId?: SessionId) => Promise<void>;
  /** Export the curated review as portable Markdown through the same save
   * seam and the same origin derivation; outdated notes resolve against the loaded
   * diff. */
  exportReviewMarkdown: (sessionId?: SessionId) => Promise<void>;
  clearReviewExportFailure: () => void;
};

/** The authored artifact this session exports. An imported review re-emits its
 * origin verbatim. A plain repo session is projected from its on-screen
 * diff: a branch comparison exports as refs; a commit-range or working-tree diff
 * embeds a frozen patch re-read from git so its comments place on their exact
 * authored lines. `"nothing"` is a session with no diff selected — there is
 * genuinely nothing to export; `"diffUnreadable"` is a needed re-read that failed,
 * surfaced rather than silently dropped. An imported review's origin *is* this shape
 * already (`ReviewOrigin`), so re-emitting one is a pass-through. */
type ExportResolution = ReviewOrigin | "nothing" | "diffUnreadable";

async function resolveExportOrigin(
  bridge: ReviewerBridge,
  slice: SessionSlice,
): Promise<ExportResolution> {
  if (slice.reviewOrigin !== null) {
    return slice.reviewOrigin;
  }
  if (slice.selection === null) {
    return "nothing";
  }
  const { repo, base, head, needsPatch } = exportSourceFor(
    slice.selection,
    slice.repo,
    headShaOf(slice.log),
  );
  if (!needsPatch) {
    return { repo, base, head, patch: null };
  }
  const response = await bridge.getDiff({
    repoPath: slice.repo.path,
    selection: slice.selection,
  });
  if (!response.ok) {
    return "diffUnreadable";
  }
  // An empty patch is no usable frozen diff (and no comment could have anchored on
  // it): fall through to the source refs rather than freezing an empty artifact.
  const patch = response.value.patch;
  return { repo, base, head, patch: patch.length > 0 ? patch : null };
}

export const createExportSlice: StateCreator<ReviewState, [], [], ExportSlice> = (set, get) => ({
  reviewExportFailure: null,

  exportReviewJson: async (sessionId) => {
    const bridge = window.reviewer;
    if (!bridge) {
      return;
    }
    await withSlice(get, sessionId, async (slice) => {
      const origin = await resolveExportOrigin(bridge, slice);
      if (origin === "nothing") {
        return;
      }
      if (origin === "diffUnreadable") {
        set({ reviewExportFailure: { kind: "diffUnreadable" } });
        return;
      }
      const artifact = serializeReview({
        repo: origin.repo,
        base: origin.base,
        head: origin.head,
        patch: origin.patch,
        overview: slice.overview,
        comments: slice.comments,
        layers: slice.layers,
      });
      const response = await bridge.saveReviewJson({
        content: `${JSON.stringify(artifact, null, 2)}\n`,
        defaultName: `${reviewFileBase(slice.repo.name)}.reviewer.json`,
      });
      // A cancel or a successful write clears any prior failure; a failed write
      // surfaces — never swallowed, or the reviewer thinks the review was saved.
      set({
        reviewExportFailure: response.ok ? null : { kind: "write", failure: response.failure },
      });
    });
  },

  exportReviewMarkdown: async (sessionId) => {
    const bridge = window.reviewer;
    if (!bridge) {
      return;
    }
    await withSlice(get, sessionId, async (slice) => {
      const origin = await resolveExportOrigin(bridge, slice);
      if (origin === "nothing") {
        return;
      }
      if (origin === "diffUnreadable") {
        set({ reviewExportFailure: { kind: "diffUnreadable" } });
        return;
      }
      // "Frozen" keys off the exported artifact's own patch, not the `reviewDiff`
      // render pin (which is cleared once the reviewer navigates to their own diff):
      // an artifact carrying an embedded patch places every anchor, so its comments
      // are never outdated regardless of what diff is on screen. A refs export
      // resolves against the loaded diff — best effort; with none loaded (or after
      // navigating away) its comments flag outdated, the honest "no authored diff to
      // place against right now" state rather than a silent claim they place.
      const frozen = origin.patch !== null;
      const files = slice.diff.phase === "loaded" ? slice.diff.files : [];
      const comments = markdownCommentsFrom(slice.comments, files, frozen);
      const response = await bridge.saveReviewMarkdown({
        content: reviewToMarkdown({
          repo: origin.repo,
          base: origin.base,
          head: origin.head,
          overview: slice.overview,
          layers: slice.layers,
          comments,
        }),
        defaultName: `${reviewFileBase(slice.repo.name)}.md`,
      });
      set({
        reviewExportFailure: response.ok ? null : { kind: "write", failure: response.failure },
      });
    });
  },

  clearReviewExportFailure: () => {
    set({ reviewExportFailure: null });
  },
});
