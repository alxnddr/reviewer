import { useEffect, type ReactElement } from "react";
import type { GitFailure } from "../../../shared/git";
import { DiffField } from "@/components/DiffField";
import { EmptyState } from "@/components/EmptyState";
import { OnboardingCard } from "@/components/Onboarding";
import { useOnboardingStore } from "@/stores/onboarding";
import { useRecentReviewsStore } from "@/stores/recent-reviews";
import { useReviewStore } from "@/stores/review";

// What the window is when it holds no review: the whole area under the title bar, one
// backdrop, and one card centred on it.
//
// This exists because the app used to open on its own skeleton. The shell painted first —
// title bar, an empty rail, an empty content well — and the store answered a few frames
// later, so every launch began with a picture of a tool with nothing in it, and a reader
// whose first impression was "something failed to load". The fix is not a spinner. It is
// that the surface is up from the first frame and the card lands on it when there is
// something to say: while the store is still answering, this is a soft field of code and
// nothing else, which is a resting state rather than a broken one.
//
// The rail is gone here for the same reason (see AppShell). A sidebar is the index of a
// review — files, layers, comments — and with no review it is an empty column framing an
// empty page, which reads as chrome that lost its content.

type StartScreenProps = {
  /** A failed open has no session pane to report in; the card carries it. */
  failure: GitFailure | null;
};

export function StartScreen({ failure }: StartScreenProps): ReactElement {
  const booted = useReviewStore((state) => state.boot === "ready");
  const guideOpen = useOnboardingStore((state) => state.open);
  const refreshRecents = useRecentReviewsStore((state) => state.refresh);

  // Read the reviews directory as soon as this screen is up, because the card below has a
  // decision to make that depends on it: whether there is any past work to offer a way back
  // to. It is one directory listing, it is off the critical path (the card renders either way
  // and gains a footer button when the answer arrives), and this screen is the one place in
  // the app where the answer is load-bearing rather than on-demand.
  useEffect(() => {
    void refreshRecents();
  }, [refreshRecents]);

  return (
    <div className="relative flex h-full items-center justify-center overflow-hidden">
      <DiffField />
      {/* Three states, in the order they occur: still hydrating (backdrop only, no card to
          show yet and no guess made about which one), the first-run guide, and the standing
          empty state. Nothing here waits on the *guide's* hydration specifically — until
          main answers, `open` is false and the boot gate keeps the card off anyway. */}
      {guideOpen ? <OnboardingCard /> : booted ? <EmptyState failure={failure} /> : null}
    </div>
  );
}
