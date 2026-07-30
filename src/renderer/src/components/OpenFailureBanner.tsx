import type { ReactElement } from "react";
import { XIcon } from "lucide-react";
import { GitFailureText } from "@/components/GitFailureText";
import { Button } from "@/components/ui/button";
import { TooltipHint } from "@/components/ui/tooltip";
import { gitFailureMessage } from "@/lib/git-failure-message";
import { useReviewStore } from "@/stores/review";

/** A failed open while a session is active: app-level state with no session
 * pane to report in, surfaced as a dismissible bar under the title bar.
 * Session-less failures render on the start screen instead. */
export function OpenFailureBanner(): ReactElement | null {
  const failure = useReviewStore((state) =>
    state.activeSessionId === null ? null : state.openFailure,
  );
  const clearOpenFailure = useReviewStore((state) => state.clearOpenFailure);

  if (failure === null) {
    return null;
  }
  return (
    <div
      role="alert"
      className="flex shrink-0 items-center gap-3 border-b border-border bg-sidebar py-1.5 pr-3 pl-4"
    >
      {/* A clipped message needs an affordance. */}
      <TooltipHint content={gitFailureMessage(failure)} whenTruncated side="bottom" align="start">
        <p className="min-w-0 truncate text-sm">
          <GitFailureText failure={failure} />
        </p>
      </TooltipHint>
      <TooltipHint content="Dismiss" side="bottom" align="end">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Dismiss"
          onClick={clearOpenFailure}
          className="ml-auto shrink-0 hover:bg-border/60 dark:hover:bg-border/60"
        >
          <XIcon className="size-3.5" />
        </Button>
      </TooltipHint>
    </div>
  );
}
