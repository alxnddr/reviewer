import type { ReactElement } from "react";
import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipHint } from "@/components/ui/tooltip";
import { reviewOpenFailureMessage } from "@/lib/review-open-failure-message";
import { useReviewStore } from "@/stores/review";

/** A failed review open: app-level, like a failed repo open — the open never
 * produced a session to report in, so it surfaces as a dismissible bar under the
 * title bar (the OpenFailureBanner treatment). Shown regardless of whether a
 * session is active, since a drop/CLI open can fail from the empty state or over
 * an open review alike. */
export function ReviewOpenFailureBanner(): ReactElement | null {
  const failure = useReviewStore((state) => state.reviewOpenFailure);
  const clearReviewOpenFailure = useReviewStore((state) => state.clearReviewOpenFailure);

  if (failure === null) {
    return null;
  }
  const message = reviewOpenFailureMessage(failure);
  return (
    <div
      role="alert"
      className="flex shrink-0 items-center gap-3 border-b border-border bg-sidebar py-1.5 pr-3 pl-4"
    >
      {/* A clipped message needs an affordance. */}
      <TooltipHint content={message} whenTruncated side="bottom" align="start">
        <p className="min-w-0 truncate text-sm">{message}</p>
      </TooltipHint>
      <TooltipHint content="Dismiss" side="bottom" align="end">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Dismiss"
          onClick={clearReviewOpenFailure}
          className="ml-auto shrink-0 hover:bg-border/60 dark:hover:bg-border/60"
        >
          <XIcon className="size-3.5" />
        </Button>
      </TooltipHint>
    </div>
  );
}
