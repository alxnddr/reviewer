import type { ReactElement } from "react";
import { History } from "lucide-react";
import type { GitFailure } from "../../../shared/git";
import { AgentPromptBlock, AnyAgentNote } from "@/components/AgentPrompt";
import { GitFailureText } from "@/components/GitFailureText";
import { GLASS_MUTED } from "@/components/Glass";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useOnboardingStore } from "@/stores/onboarding";
import { useRecentReviewsStore } from "@/stores/recent-reviews";

type EmptyStateProps = {
  /** A failed open attempt has no session pane to report in; it reports here. */
  failure: GitFailure | null;
};

// Where the app stands when it holds nothing: after the first-run guide, and after the last
// tab is closed. It is the same card the guide ends on, because it is the same question —
// what do I do now — and the answer never changes: ask your agent, and the review turns up
// here. Anything else on this screen is a detour from that sentence.
//
// So "Open repository" is no longer the thing being offered. It used to be the only button
// on the screen, which told every new reader that Reviewer is a diff viewer they drive by
// picking folders — the one wrong idea this app can leave someone with, and the reason they
// then sit in front of a repo with no review in it wondering what the point is. Browsing a
// repo without a review is still real, and still here; it is just not the answer to "what
// now", so it sits in the footer with the other quiet door.
//
// The signature device stays: the empty state speaks in diff, and the line it strikes out is
// the state itself. Band colors are the Pierre-derived content tokens; marker glyphs use the
// AA-validated status tones.
export function EmptyState({ failure }: EmptyStateProps): ReactElement {
  const showGuide = useOnboardingStore((state) => state.show);
  const recentCount = useRecentReviewsStore((state) => state.reviews.length);
  const openRecents = useRecentReviewsStore((state) => state.openPanel);

  return (
    <div
      data-glass
      className="relative w-[min(44rem,calc(100%-5rem))] rounded-2xl p-7 duration-200 animate-in fade-in zoom-in-95"
    >
      <div className="overflow-hidden rounded-xl border border-foreground/10 font-mono text-[15px]">
        <p className="flex items-center gap-3 bg-diff-del-bg px-4 py-2.5">
          <span aria-hidden="true" className="text-diff-del-fg">
            -
          </span>
          nothing to review
        </p>
        <p className="flex items-center gap-3 bg-diff-add-bg px-4 py-2.5">
          <span aria-hidden="true" className="text-diff-add-fg">
            +
          </span>
          ask your agent for one
        </p>
      </div>

      <p className="mt-5 text-base leading-relaxed text-text-muted">
        Paste this into your agent, from inside the repo you want reviewed:
      </p>
      <div className="mt-3">
        <AgentPromptBlock note={<AnyAgentNote />} />
      </div>

      {failure !== null && (
        <p className="mt-3 text-base text-text-muted">
          <GitFailureText failure={failure} />
        </p>
      )}

      {/* One door, and it is the explanation. Opening a repository to browse its diff
          without a review is real and still here — ⌘O, and File ▸ Open Repository — but a
          button for it on this card competes with the sentence above it for the reader who
          has not yet worked out what the app is for, and wins: picking a folder is a thing
          you know how to do, and asking an agent for a review is not, yet.

          Recents is the one exception, and it earns it by being conditional. It appears only
          once this machine has reviews to go back to — which is to say, only for a reader who
          has already understood the sentence above and does not need it a second time. On a
          fresh install it is not there at all, so the first-run card is exactly what it was.
          Leading, because by then it is the more likely errand: the card's own advice is for
          someone with no review, and this footer is for someone with twenty. */}
      <footer className="mt-4 flex items-center justify-between gap-2 border-t border-foreground/10 pt-3">
        <div>
          {recentCount > 0 && (
            <Button
              variant="ghost"
              className={cn("rounded-full", GLASS_MUTED)}
              onClick={openRecents}
            >
              <History aria-hidden="true" />
              Recent reviews
              <span className="ml-0.5 tabular-nums opacity-60">{recentCount}</span>
            </Button>
          )}
        </div>
        <Button variant="ghost" className={cn("rounded-full", GLASS_MUTED)} onClick={showGuide}>
          How this works
        </Button>
      </footer>
    </div>
  );
}
