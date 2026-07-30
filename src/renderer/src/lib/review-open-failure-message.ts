import { assertNever } from "../../../shared/assert";
import type { ReviewOpenFailure } from "../../../shared/review-open";
import { gitFailureMessage } from "./git-failure-message";

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
      return "That file is not a valid review.";
    case "repoUnavailable":
      // The review is fine; the repository it names is the problem — say so, then
      // let the git layer's own sentence name the path it refused.
      return `That review's repository could not be opened. ${gitFailureMessage(failure.reason)}`;
    default:
      return assertNever(failure);
  }
}
