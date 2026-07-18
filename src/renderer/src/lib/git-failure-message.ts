import type { GitFailure } from "../../../shared/git";
import { assertNever } from "../../../shared/assert";

/** Shared with GitFailureText, which renders the path portion in mono. */
export const NOT_A_REPO_SUFFIX = " is not a git repository.";

/** User-facing sentence for each GitFailure code (stderr never crosses IPC). */
export function gitFailureMessage(failure: GitFailure): string {
  switch (failure.code) {
    case "gitMissing":
      return "git was not found on this system. Install git and try again.";
    case "notARepo":
      return `${failure.path}${NOT_A_REPO_SUFFIX}`;
    case "unknownRevision":
      return "This revision no longer exists in the repository.";
    case "invalidRange":
      return "This diff range is not valid.";
    case "outputOverflow":
      return `This diff exceeds the ${Math.round(failure.limitBytes / (1024 * 1024))} MiB limit.`;
    case "timeout":
      return "git took too long to answer.";
    case "unexpected":
      return "git failed unexpectedly. Check the application logs.";
    default:
      return assertNever(failure);
  }
}
