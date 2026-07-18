import { assertNever } from "../../../shared/assert";
import type { ReviewSaveFailure } from "../../../shared/review-save";

/** Why an export did not complete. Two origins the reviewer must be able to tell
 * apart: `write` is main's typed fs failure (the save sheet ran, the disk write
 * lost); `diffUnreadable` is a renderer-side stop — the on-screen diff had to be
 * re-read from git to embed a frozen patch (a commit-range or working-tree review)
 * and that read failed, so no artifact could be built and the sheet never opened. */
export type ReviewExportFailure =
  | { kind: "write"; failure: ReviewSaveFailure }
  | { kind: "diffUnreadable" };

/** User-facing sentence for an export failure. Main maps any fs error to a
 * `ReviewSaveFailure` code before it crosses IPC, so the renderer only ever
 * shows a known, typed reason — never a raw write error or a leaked path. */
export function reviewExportFailureMessage(failure: ReviewExportFailure): string {
  switch (failure.kind) {
    case "write":
      switch (failure.failure.code) {
        case "writeFailed":
          return "The review could not be saved to that location.";
        default:
          // `.code` (not `failure`) so this still narrows to `never` while the wire
          // union has a single arm — a new failure code then breaks the build here.
          return assertNever(failure.failure.code);
      }
    case "diffUnreadable":
      return "The current diff could not be read, so the review was not exported.";
    default:
      return assertNever(failure);
  }
}
