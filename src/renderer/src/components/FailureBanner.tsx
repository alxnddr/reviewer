import type { ReactElement, ReactNode } from "react";
import { XIcon } from "lucide-react";
import { GitFailureText } from "@/components/GitFailureText";
import { Button } from "@/components/ui/button";
import { TooltipHint } from "@/components/ui/tooltip";
import { gitFailureMessage } from "@/lib/git-failure-message";
import { reviewExportFailureMessage } from "@/lib/review-export-failure-message";
import { reviewOpenFailureMessage } from "@/lib/review-open-failure-message";
import { useReviewStore } from "@/stores/review";

type FailureBannerProps = {
  /** The failure in full, as text: what the tooltip recovers once the bar clips it. */
  message: string;
  /** What the bar reads as — the message itself, or a marked-up rendering of it. */
  body: ReactNode;
  onDismiss: () => void;
};

/** The bar the app-level failures share: one line under the title bar, the message
 * clipped to a single line, a dismiss at the end. Which failure it is lives in the
 * three wrappers below — all this knows is a string, a body and a way to close. */
function FailureBanner({ message, body, onDismiss }: FailureBannerProps): ReactElement {
  return (
    <div
      role="alert"
      className="flex shrink-0 items-center gap-3 border-b border-border bg-sidebar py-1.5 pr-3 pl-4"
    >
      {/* A clipped message needs an affordance. */}
      <TooltipHint content={message} whenTruncated side="bottom" align="start">
        <p className="min-w-0 truncate text-sm">{body}</p>
      </TooltipHint>
      <TooltipHint content="Dismiss" side="bottom" align="end">
        <Button
          variant="chrome"
          size="icon-sm"
          aria-label="Dismiss"
          onClick={onDismiss}
          className="ml-auto shrink-0"
        >
          <XIcon className="size-3.5" />
        </Button>
      </TooltipHint>
    </div>
  );
}

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
    <FailureBanner
      message={gitFailureMessage(failure)}
      body={<GitFailureText failure={failure} />}
      onDismiss={clearOpenFailure}
    />
  );
}

/** A failed review open: app-level, like a failed repo open — the open never
 * produced a session to report in, so it surfaces as a dismissible bar under the
 * title bar (the OpenFailureBanner treatment). Shown regardless of whether a
 * session is active, since a drop/CLI open can fail from the start screen or over
 * an open review alike. */
export function ReviewOpenFailureBanner(): ReactElement | null {
  const failure = useReviewStore((state) => state.reviewOpenFailure);
  const clearReviewOpenFailure = useReviewStore((state) => state.clearReviewOpenFailure);

  if (failure === null) {
    return null;
  }
  const message = reviewOpenFailureMessage(failure);
  return <FailureBanner message={message} body={message} onDismiss={clearReviewOpenFailure} />;
}

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
  return <FailureBanner message={message} body={message} onDismiss={clearReviewExportFailure} />;
}
