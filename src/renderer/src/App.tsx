import { useEffect, useRef, type ReactElement } from "react";
import { AppShell } from "@/components/AppShell";
import { CliBanner } from "@/components/CliBanner";
import { DiffScreen } from "@/components/DiffScreen";
import { DiffWorkerPool } from "@/components/DiffWorkerPool";
import { OpenFailureBanner } from "@/components/OpenFailureBanner";
import { ReviewDropZone } from "@/components/ReviewDropZone";
import { ReviewExportFailureBanner } from "@/components/ReviewExportFailureBanner";
import { ReviewOpenFailureBanner } from "@/components/ReviewOpenFailureBanner";
import { OverviewScreen } from "@/components/OverviewScreen";
import { RecentReviews } from "@/components/RecentReviews";
import { ShortcutsDialog } from "@/components/ShortcutsDialog";
import { Sidebar } from "@/components/Sidebar";
import { SidebarNav } from "@/components/SidebarNav";
import { StartScreen } from "@/components/StartScreen";
import { nextRegion, visibleRegions } from "@/lib/focus-regions";
import { shortcutBlocked } from "@/lib/shortcut-guard";
import { useOnboardingStore } from "@/stores/onboarding";
import { useRecentReviewsStore } from "@/stores/recent-reviews";
import { selectActiveSlice, useReviewStore } from "@/stores/review";

/** `o` toggles the tour doc from anywhere in a review — into it from the diff, and back
 * out to the full diff from inside it. Mounted at the app level (not in either screen)
 * because it has to work on both sides of the switch. Guarded like the other
 * single-letter shortcuts (j/k, n/p) through the one shared rule: never inside a text field,
 * never with a modifier, never behind an open sheet. */
function useOverviewShortcut(): void {
  const hasOverview = useReviewStore((state) => selectActiveSlice(state)?.overview != null);
  const overviewOpen = useReviewStore((state) => selectActiveSlice(state)?.overviewOpen ?? false);
  const openOverview = useReviewStore((state) => state.openOverview);
  const closeOverview = useReviewStore((state) => state.closeOverview);

  useEffect(() => {
    if (!hasOverview) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "o" || shortcutBlocked(event)) {
        return;
      }
      event.preventDefault();
      if (overviewOpen) {
        closeOverview();
      } else {
        openOverview();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [hasOverview, overviewOpen, openOverview, closeOverview]);
}

/** j/k step the focused file, n/p walk the comments, Escape ends the walk, r marks the focused
 * file read — the review's whole letter vocabulary, all of it acting on the session rather than
 * on whatever is painted.
 *
 * They live here, beside `o` and F6, rather than in DiffScreen, which is where they used to be
 * and where they were only half true: DiffScreen is unmounted the whole time the tour doc is up,
 * so every one of these keys was silently dead on the doc — including the ones whose store
 * action closes the doc as its first move, which is exactly what a reader pressing `j` in there
 * means by it. The sheet says single keys work anywhere, and now they do; the actions already
 * no-op with no session and no loaded diff, so nothing has to check where it is. */
function useReviewShortcuts(): void {
  const selectAdjacentFile = useReviewStore((state) => state.selectAdjacentFile);
  const stepComment = useReviewStore((state) => state.stepComment);
  const clearActiveComment = useReviewStore((state) => state.clearActiveComment);
  const toggleFileRead = useReviewStore((state) => state.toggleFileRead);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (shortcutBlocked(event)) {
        return;
      }
      switch (event.key) {
        case "j":
        case "k":
          event.preventDefault();
          selectAdjacentFile(event.key === "j" ? 1 : -1);
          break;
        case "n":
        case "p":
          event.preventDefault();
          stepComment(event.key === "n" ? 1 : -1);
          break;
        // Marking does not move: a reader who marks the file they are looking at is still
        // looking at it, and a surface that jumped out from under that press would make the
        // whole gesture something to be careful with.
        case "r":
          event.preventDefault();
          toggleFileRead();
          break;
        // No preventDefault — Escape is shared (the layer tree clears its solo with it, a
        // field clears its filter), and this handler only ever ends the comment walk.
        case "Escape":
          clearActiveComment();
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectAdjacentFile, stepComment, clearActiveComment, toggleFileRead]);
}

/** F6 (⇧F6 backwards) steps focus between the shell's big regions — the layer tree, the
 * comment overview, the file tree, and the diff or the doc. Mounted at the app level for
 * the same reason `o` is: the regions it walks are spread across both screens, and it has
 * to keep working whichever one is up.
 *
 * A modifier guard is deliberately absent past shift: F6 is a function key, so it cannot
 * collide with typing, and it must keep working while focus is in the file filter — that
 * field is *inside* a region, and being stuck in it is exactly what this key is for. */
function useRegionShortcut(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "F6" || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      const target = nextRegion(visibleRegions(), document.activeElement, event.shiftKey ? -1 : 1);
      if (target === null) {
        return;
      }
      event.preventDefault();
      target.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

/** The first-run guide's two app-level facts: it asks main whether it has ever run, and it
 * counts itself run the moment a review turns up while it is open — the CLI is installed,
 * the agent knows the way, and there is a diff waiting behind the card, which is every
 * question the guide asks answered at once.
 *
 * Both live here rather than in the card because the card unmounts at exactly the moment the
 * second one has to fire: a session arriving is what takes the start screen off the screen.
 *
 * "Turns up" is strictly an arrival — a tab restored from last launch is not evidence of
 * anything, and treating it as one marked the guide read on behalf of every reader who had
 * one open. The boot phase is part of that test because hydration settles the store and
 * restores the strip in a single commit, so "there was no session and now there is" is
 * otherwise true of every launch that restores one. */
function useOnboardingLifecycle(): void {
  const hydrate = useOnboardingStore((state) => state.hydrate);
  const open = useOnboardingStore((state) => state.open);
  const finish = useOnboardingStore((state) => state.finish);
  const activeSessionId = useReviewStore((state) => state.activeSessionId);
  const booted = useReviewStore((state) => state.boot === "ready");

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  const previous = useRef({ booted: false, sessionId: null as string | null });
  useEffect(() => {
    const arrived =
      previous.current.booted && previous.current.sessionId === null && activeSessionId !== null;
    previous.current = { booted, sessionId: activeSessionId };
    if (open && arrived) {
      finish();
    }
  }, [open, activeSessionId, booted, finish]);
}

/** The recents picker, wired to the same command the File menu sends so the accelerator and
 * the menu item are one action rather than two implementations of one. Toggling rather than
 * opening: the key that put the panel up is the one a reader will press to take it down, and
 * arriving at a panel that is already open and pressing it again should not be a no-op. */
function useRecentReviewsCommand(): void {
  const open = useRecentReviewsStore((state) => state.open);
  const openPanel = useRecentReviewsStore((state) => state.openPanel);
  const close = useRecentReviewsStore((state) => state.close);

  useEffect(() => {
    const bridge = window.reviewer;
    if (!bridge) {
      return;
    }
    return bridge.onOpenRecentReviewsCommand(() => {
      if (open) {
        close();
      } else {
        openPanel();
      }
    });
  }, [open, openPanel, close]);
}

export function App(): ReactElement {
  const activeSessionId = useReviewStore((state) => state.activeSessionId);
  // The start screen is the shell's content either because there is no review to show, or
  // because the reader has a start tab focused over the one they have open (⌘T / the strip's
  // `+`).
  const activeStartTabId = useReviewStore((state) => state.activeStartTabId);
  // The tour doc replaces the diff pane while it is the reader's stop. The slice's
  // invariant (`overviewOpen` implies a doc exists) is re-checked here so a session
  // without one can never resolve to an empty screen.
  const showOverview = useReviewStore((state) => {
    const slice = selectActiveSlice(state);
    return slice?.overviewOpen === true && slice.overview !== null;
  });
  const openFailure = useReviewStore((state) => state.openFailure);
  const hydrate = useReviewStore((state) => state.hydrate);
  const openRepository = useReviewStore((state) => state.openRepository);
  const openReview = useReviewStore((state) => state.openReview);
  const exportReviewJson = useReviewStore((state) => state.exportReviewJson);
  const exportReviewMarkdown = useReviewStore((state) => state.exportReviewMarkdown);
  const copyActiveCommentPrompt = useReviewStore((state) => state.copyActiveCommentPrompt);
  const copyAllCommentsPrompt = useReviewStore((state) => state.copyAllCommentsPrompt);
  const syncSessions = useReviewStore((state) => state.syncSessions);
  const closeSession = useReviewStore((state) => state.closeSession);
  const cycleActiveSession = useReviewStore((state) => state.cycleActiveSession);
  const activateTabByOrdinal = useReviewStore((state) => state.activateTabByOrdinal);
  const openStartTab = useReviewStore((state) => state.openStartTab);
  const showStart = activeSessionId === null || activeStartTabId !== null;

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  useOverviewShortcut();
  useReviewShortcuts();
  useRegionShortcut();
  useOnboardingLifecycle();
  useRecentReviewsCommand();

  useEffect(() => {
    const bridge = window.reviewer;
    if (!bridge) {
      return;
    }
    const unsubscribes = [
      bridge.onOpenRepoCommand(() => void openRepository()),
      bridge.onOpenReviewCommand(() => void openReview()),
      bridge.onExportReviewJsonCommand(() => void exportReviewJson()),
      bridge.onExportReviewMarkdownCommand(() => void exportReviewMarkdown()),
      // ⇧⌘C / ⌥⇧⌘C. The return value is dropped here on purpose: the control that speaks
      // for what was copied flashes off the store's own record (`promptCopy`), so a
      // keystroke and a click are acknowledged by the same glyph through the same path.
      bridge.onCopyCommentPromptCommand(() => void copyActiveCommentPrompt()),
      bridge.onCopyAllCommentsPromptCommand(() => void copyAllCommentsPrompt()),
      // A CLI/`open-file` import wrote a session in main; re-list to surface it.
      bridge.onSessionsChanged(() => void syncSessions()),
      bridge.onNewTabCommand(openStartTab),
      bridge.onCloseTabCommand(() => closeSession()),
      bridge.onCycleTabCommand(cycleActiveSession),
      bridge.onActivateTabCommand(activateTabByOrdinal),
    ];
    return () => {
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
    };
  }, [
    openRepository,
    openReview,
    exportReviewJson,
    exportReviewMarkdown,
    copyActiveCommentPrompt,
    copyAllCommentsPrompt,
    syncSessions,
    closeSession,
    cycleActiveSession,
    activateTabByOrdinal,
    openStartTab,
  ]);

  return (
    <DiffWorkerPool>
      {/* Outside the shell, not in it: `?` has to answer from the start screen too, before
          there is any session for the shell to be about. */}
      <ShortcutsDialog />
      {/* Same placement, same reason: the searchable list of past reviews has to be reachable
          from inside a review, where there is no page listing them — the start screen lists
          the recent ones itself and opens this for the rest. */}
      <RecentReviews />
      {/* The standing "no rvw, no reviews" notice. Above the shell too, because it is true
          of the app rather than of whatever session happens to be open. */}
      <CliBanner />
      <ReviewDropZone>
        <AppShell
          banner={
            <>
              <OpenFailureBanner />
              <ReviewOpenFailureBanner />
              <ReviewExportFailureBanner />
            </>
          }
          sidebar={
            showStart ? null : (
              <Sidebar>
                {/* Keyed per session so the selector/tree view resets on entry. */}
                <SidebarNav key={activeSessionId} />
              </Sidebar>
            )
          }
        >
          {showStart ? (
            // Everything before the first review, the moment after the last tab closes, and
            // any time the reader focuses a start tab over a review they are keeping. It owns
            // its own settling, so nothing here waits on the store.
            //
            // Keyed per start tab so each one keeps its own screen state — a half-typed search
            // on one is not a half-typed search on the next, which is what having two of them
            // is for.
            <StartScreen key={activeStartTabId ?? "start"} failure={openFailure} />
          ) : showOverview ? (
            <OverviewScreen />
          ) : (
            <DiffScreen />
          )}
        </AppShell>
      </ReviewDropZone>
    </DiffWorkerPool>
  );
}
