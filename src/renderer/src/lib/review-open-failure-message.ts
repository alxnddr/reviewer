import { assertNever } from "../../../shared/assert";
import type { ReviewOpenFailure } from "../../../shared/review-open";

/** User-facing sentence for each ReviewOpenFailure code. The guard maps
 * every bad path/artifact to one of these before any read or spawn, so the
 * renderer only ever shows a known, typed reason — never a raw error. */
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
    default:
      return assertNever(failure);
  }
}
