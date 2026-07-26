import type { ReactElement } from "react";
import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipHint } from "@/components/ui/tooltip";
import { reviewExportFailureMessage } from "@/lib/review-export-failure-message";
import { useReviewStore } from "@/stores/review";

/** A failed review export: app-level, like the open-failure bars — the write
 * belongs to the shell, not a session, so it surfaces as a dismissible bar under
 * the title bar. Without it a swallowed write would read as a successful save,
 * the worst kind of silent failure. */
export function ReviewExportFailureBanner(): ReactElement | null {
  const failure = useReviewStore((state) => state.reviewExportFailure);
  const clearReviewExportFailure = useReviewStore((state) => state.clearReviewExportFailure);

  if (failure === null) {
    return null;
  }
  const message = reviewExportFailureMessage(failure);
  return (
    <div
      role="alert"
      className="flex shrink-0 items-center gap-3 border-b border-border bg-sidebar py-1.5 pr-3 pl-4"
    >
      {/* A clipped message needs an affordance. */}
      <TooltipHint content={message} whenTruncated side="bottom" align="start">
        <p className="min-w-0 truncate text-sm">{message}</p>
      </TooltipHint>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Dismiss"
        onClick={clearReviewExportFailure}
        className="ml-auto shrink-0 hover:bg-border/60 dark:hover:bg-border/60"
      >
        <XIcon className="size-3.5" />
      </Button>
    </div>
  );
}
