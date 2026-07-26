import type { ReactElement } from "react";
import type { GitFailure } from "../../../shared/git";
import { gitFailureMessage, NOT_A_REPO_SUFFIX } from "@/lib/git-failure-message";

type GitFailureTextProps = {
  failure: GitFailure;
};

/** gitFailureMessage, with the path carrying the sentence's ink so it reads as the
 * subject of it. Sans, like every other path in the app: mono is reserved for code —
 * the diff, a snippet, an inline `code` span — and a filesystem path is none of those. */
export function GitFailureText({ failure }: GitFailureTextProps): ReactElement {
  if (failure.code === "notARepo") {
    return (
      <>
        <span className="text-foreground">{failure.path}</span>
        {NOT_A_REPO_SUFFIX}
      </>
    );
  }
  return <>{gitFailureMessage(failure)}</>;
}
