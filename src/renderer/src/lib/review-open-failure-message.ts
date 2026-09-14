import { assertNever } from "../../../shared/assert";
import type { ReviewOpenFailure } from "../../../shared/review-ipc";
import { gitFailureMessage } from "./git-failure-message";
import { shortRef } from "./refs";

/** User-facing sentence for each ReviewOpenFailure code. The open path maps every
 * bad path/artifact — and every repo an artifact names that git will not open — to
 * one of these, so the renderer only ever shows a known, typed reason, never a raw
 * error. */
export function reviewOpenFailureMessage(failure: ReviewOpenFailure): string {
  switch (failure.code) {
    case "wrongExtension":
      return "That is not a .reviewer.json review file.";
    case "fileNotFound":
      return "That review file could not be found.";
    case "tooLarge":
      return "That review file is too large to open.";
    case "unreadable":
      return "That review file could not be read.";
    case "invalidContent":
      // The file *was* read, so the reader can go and fix it — the schema's own account of
      // the first thing it objected to names the field, the way the git layer's sentence
      // names the path below.
      return `That file is not a valid review: ${failure.reason}`;
    case "repoUnavailable":
      // The review is fine; the repository it names is the problem — say so, then
      // let the git layer's own sentence name the path it refused.
      return `That review's repository could not be opened. ${gitFailureMessage(failure.reason)}`;
    case "refsUnavailable":
      // The repository is fine; the commits are not in it yet. Name them, so the reader knows
      // what to fetch rather than which directory to doubt.
      return `That review's commits are not in its repository (${failure.missing.map(shortRef).join(", ")}). Fetch them, or locate the checkout that has them.`;
    case "patchMismatch":
      return "That repository has the review's commits, but not the diff the review carries — its branch has moved since. The review stays on its own copy of the diff.";
    default:
      return assertNever(failure);
  }
}

/** Whether Locate Repository… can answer a failure: the review itself was fine and only its
 * repository was not where it said. A value-returning switch with no default, so a new failure
 * code has to take a side instead of silently offering no way forward. */
export function failureInvitesLocate(failure: ReviewOpenFailure): boolean {
  switch (failure.code) {
    case "wrongExtension":
    case "fileNotFound":
    case "tooLarge":
    case "unreadable":
    case "invalidContent":
      return false;
    case "repoUnavailable":
    case "refsUnavailable":
    case "patchMismatch":
      return true;
  }
}
