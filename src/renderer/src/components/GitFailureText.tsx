import type { ReactElement } from "react";
import type { GitFailure } from "../../../shared/git";
import { gitFailureMessage, NOT_A_REPO_SUFFIX } from "@/lib/git-failure-message";

type GitFailureTextProps = {
  failure: GitFailure;
};

/** gitFailureMessage with the design rule applied: machine tokens (here the repo
 * path) render mono inside an otherwise sans sentence. */
export function GitFailureText({ failure }: GitFailureTextProps): ReactElement {
  if (failure.code === "notARepo") {
    return (
      <>
        <span className="font-mono">{failure.path}</span>
        {NOT_A_REPO_SUFFIX}
      </>
    );
  }
  return <>{gitFailureMessage(failure)}</>;
}
