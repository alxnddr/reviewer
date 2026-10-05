import type { GitFailure } from "../../../shared/git";
import { assertNever } from "../../../shared/assert";

/** Shared with GitFailureText, which renders the path portion in mono. */
export const NOT_A_REPO_SUFFIX = " is not a git repository.";

/** User-facing sentence for each GitFailure code (stderr never crosses IPC, bar the one
 * scrubbed line `remoteFailed` carries — `shared/git.ts` says why). */
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
    // The remote's answers (a fetch, a clone). Each one ends on what the reader can do,
    // because none of them is the app's to fix: git runs with the reader's own credentials,
    // and the sentences say so rather than implying the app holds any.
    case "authFailed":
      return "git could not sign in to the remote. It uses your own credentials — an SSH key or a credential helper — so check that a plain git fetch of this repository works in a terminal. An organization that enforces single sign-on needs the credential authorized for it.";
    case "remoteNotFound":
      return "The remote has no such repository — or it is private and your git credentials cannot see it.";
    case "remoteRefMissing":
      return `The remote has no ${failure.ref}.`;
    case "network":
      return "The remote could not be reached. Check the network connection and try again.";
    case "remoteFailed":
      return `git could not talk to the remote: ${failure.detail}`;
    case "cancelled":
      return "Cancelled.";
    default:
      return assertNever(failure);
  }
}
