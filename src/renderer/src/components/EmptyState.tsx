import type { ReactElement } from "react";
import type { GitFailure } from "../../../shared/git";
import { GitFailureText } from "@/components/GitFailureText";
import { Button } from "@/components/ui/button";

type EmptyStateProps = {
  onOpenRepository: () => void;
  /** A failed open attempt has no session pane to report in; it reports here. */
  failure: GitFailure | null;
};

// The signature device: the empty state speaks in diff. Band colors are the
// Pierre-derived content tokens; marker glyphs use the AA-validated status tones.
export function EmptyState({ onOpenRepository, failure }: EmptyStateProps): ReactElement {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6">
      <div className="min-w-80 overflow-hidden rounded-lg border border-border font-mono text-base">
        <p className="flex items-center gap-3 bg-diff-del-bg py-2.5 pr-12 pl-5">
          <span aria-hidden="true" className="text-diff-del-fg">
            -
          </span>
          nothing to review
        </p>
        <p className="flex items-center gap-3 bg-diff-add-bg py-2.5 pr-12 pl-5">
          <span aria-hidden="true" className="text-diff-add-fg">
            +
          </span>
          open a repository
        </p>
      </div>
      <Button
        size="lg"
        className="border-accent-strong bg-accent-strong text-accent-strong-foreground hover:bg-accent-strong/90"
        onClick={onOpenRepository}
      >
        Open repository
      </Button>
      {failure !== null && (
        <p className="max-w-96 text-center text-sm text-text-muted">
          <GitFailureText failure={failure} />
        </p>
      )}
    </div>
  );
}
