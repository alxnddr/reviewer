import { useEffect, type ReactElement } from "react";
import type { GitFailure } from "../../../shared/git";
import { AgentPromptBlock } from "@/components/AgentPrompt";
import { DiffField } from "@/components/DiffField";
import { GitFailureText } from "@/components/GitFailureText";
import { OnboardingCard } from "@/components/Onboarding";
import { ReviewHistory } from "@/components/ReviewHistory";
import { START_INSET, StartHeading, StartRule } from "@/components/StartChrome";
import { Button } from "@/components/ui/button";
import { ShortcutHint } from "@/components/ui/kbd";
import { TooltipHint } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useOnboardingStore } from "@/stores/onboarding";
import { useRecentReviewsStore } from "@/stores/recent-reviews";
import { useReviewStore } from "@/stores/review";

// What the window is when it holds no review: after the first-run guide, after the last tab is
// closed, and whenever the reader focuses a start tab from the strip.
//
// It is built out of the app's own materials — the diff surface, the rail's 36px section bar,
// the same rows and the same ink — rather than the frosted card floating over a field of fake
// code that used to stand here. That card was the only surface in the app that looked like
// that: a reader met it first, learned nothing from it about where they were about to be, and
// then never saw anything resembling it again. The guide can afford to be a card — it is shown
// once, and it is *about* the app rather than part of it. This screen is part of the app.
//
// The shape is a pane, not a document: a header that stays put, one scrolling list, a footer
// that stays put. The instructions at the top are two lines a reader reads once and scrolls
// past forever, so they do not scroll — and the list, which is the part with more of it than
// fits, is the part that moves. It is also the order of the two errands: asking for a review is
// the only thing that works on a fresh install, and coming back to one is the errand every day
// after that.
//
// The screen has two things on it and it names them — "Ask your agent for a review", "Recent
// reviews", one heading each, in one register (see StartChrome). That is what divides the page:
// a line of prose across the top was read as body text, sat at the same weight as everything
// under it, and left the two halves looking like one undivided column. The hairlines that
// remain are held to the reading column for the same reason — a full-bleed rule across a window
// this wide is louder than the boundary it marks.
//
// The two quiet doors at the foot — open a review file, read the guide again — are real, and
// neither is the answer to "what now".
//
// While the guide is up it owns the whole surface, and none of this shows behind it.

/** What a door at the foot of this screen wears: the ghost variant's fill replaced by the wash
 * every other quiet control on a content surface uses (`bg-border/50`), so the pair reads as a
 * footer rather than as two buttons. */
const DOOR = "text-text-muted hover:bg-border/50 hover:text-foreground dark:hover:bg-border/50";

type StartScreenProps = {
  /** A failed open has no session pane to report in; this screen carries it. */
  failure: GitFailure | null;
};

export function StartScreen({ failure }: StartScreenProps): ReactElement {
  const booted = useReviewStore((state) => state.boot === "ready");
  const guideOpen = useOnboardingStore((state) => state.open);
  const refreshRecents = useRecentReviewsStore((state) => state.refresh);

  // Read the reviews directory as soon as this screen is up: the list below is most of what the
  // screen is, and `rvw emit` writes into that directory while this window is running — so the
  // answer is re-read every time the screen is entered rather than cached from the last time.
  // It is one directory listing and it is off the critical path; the header renders without it.
  useEffect(() => {
    void refreshRecents();
  }, [refreshRecents]);

  if (guideOpen) {
    return (
      <div className="relative flex h-full items-center justify-center overflow-hidden">
        <DiffField />
        <OnboardingCard />
      </div>
    );
  }

  // Nothing until the store has answered. A relaunch that restores a session resolves inside a
  // frame or two, and painting a whole "you have nothing open" screen in front of a reader who
  // has three tabs open would be a lie that then vanishes. The surface is up from the first
  // frame, which is what stops that being a flash of empty chrome.
  if (!booted) {
    return <div className="h-full bg-diff-surface" />;
  }

  return (
    <div className="flex h-full flex-col bg-diff-surface">
      {/* The standing `rvw` notice floats over this screen exactly as it floats over a diff (see
          CliBanner) — it is a pill laid on the app, not a bar the app makes room for, and a
          header that grew and shrank under it would move the reader's content for a condition
          that has nothing to do with their content. */}
      <header className="shrink-0 px-6 pt-4">
        {/* Inset to the rows' own text edge (see START_INSET) so every line on the screen —
            headings, prompt, search glyph, rows, footer — starts at one x. */}
        <div className={cn("mx-auto max-w-3xl", START_INSET)}>
          <StartHeading>Ask your agent for a review</StartHeading>
          <div className="mt-2">
            <AgentPromptBlock />
          </div>
          {/* A repository that would not open has nowhere else to be said from here. */}
          {failure !== null && (
            <p className="mt-2 text-sm leading-relaxed text-text-muted">
              <GitFailureText failure={failure} />
            </p>
          )}
        </div>
      </header>

      <ReviewHistory />

      <footer className="shrink-0 px-6 pb-1.5">
        {/* No inset on the row itself: these are buttons, and a button's own padding is already
            the same 10px, so its label lands on the shared edge while its hover fill spills into
            the gutter exactly as a row's does. */}
        <div className="mx-auto w-full max-w-3xl">
          <StartRule />
          <div className="flex flex-wrap items-center justify-between gap-x-2 pt-1.5">
            <OpenReviewDoor />
            <GuideDoor />
          </div>
        </div>
      </footer>
    </div>
  );
}

/** The one picker offered here: a review someone sent, or one this app wrote and the reader has
 * moved out of `~/.rvw/reviews`.
 *
 * "Open a repository…" is deliberately *not* beside it. Browsing a repository's own diff with no
 * review in it is real and still here — ⌘O, and File ▸ Open Repository — but a button for it on
 * this screen teaches every new reader that Reviewer is a diff viewer you drive by picking
 * folders, which is the one wrong idea this app can leave someone with. Picking a folder is a
 * thing you already know how to do; asking an agent for a review is not, yet. So the menu keeps
 * it and this screen does not repeat it. */
function OpenReviewDoor(): ReactElement {
  const openReview = useReviewStore((state) => state.openReview);

  return (
    <TooltipHint
      side="top"
      align="start"
      content={<ShortcutHint action="Open a review file" keys="⇧⌘O" />}
    >
      <Button variant="ghost" size="sm" className={DOOR} onClick={() => void openReview()}>
        Open a review file…
      </Button>
    </TooltipHint>
  );
}

/** The way back into the first-run guide, for a reader who skipped it — and the only place in
 * the app that offers it. */
function GuideDoor(): ReactElement {
  const showGuide = useOnboardingStore((state) => state.show);
  return (
    <Button variant="ghost" size="sm" className={DOOR} onClick={showGuide}>
      How this works
    </Button>
  );
}
