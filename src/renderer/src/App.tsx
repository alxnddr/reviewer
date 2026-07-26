import { useEffect, type ReactElement } from "react";
import { AppShell } from "@/components/AppShell";
import { DiffScreen } from "@/components/DiffScreen";
import { DiffWorkerPool } from "@/components/DiffWorkerPool";
import { EmptyState } from "@/components/EmptyState";
import { OpenFailureBanner } from "@/components/OpenFailureBanner";
import { ReviewDropZone } from "@/components/ReviewDropZone";
import { ReviewExportFailureBanner } from "@/components/ReviewExportFailureBanner";
import { ReviewOpenFailureBanner } from "@/components/ReviewOpenFailureBanner";
import { OverviewScreen } from "@/components/OverviewScreen";
import { Sidebar } from "@/components/Sidebar";
import { SidebarNav } from "@/components/SidebarNav";
import { selectActiveSlice, useReviewStore } from "@/stores/review";

/** `o` toggles the tour doc from anywhere in a review — into it from the diff, and back
 * out to the full diff from inside it. Mounted at the app level (not in either screen)
 * because it has to work on both sides of the switch. Guarded like the other
 * single-letter shortcuts (j/k, n/p): never inside a text field, never with a modifier. */
function useOverviewShortcut(): void {
  const hasOverview = useReviewStore((state) => selectActiveSlice(state)?.overview !== null);
  const overviewOpen = useReviewStore((state) => selectActiveSlice(state)?.overviewOpen ?? false);
  const openOverview = useReviewStore((state) => state.openOverview);
  const closeOverview = useReviewStore((state) => state.closeOverview);

  useEffect(() => {
    if (!hasOverview) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target;
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.key !== "o" ||
        (target instanceof HTMLElement &&
          (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable))
      ) {
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

export function App(): ReactElement {
  const boot = useReviewStore((state) => state.boot);
  const activeSessionId = useReviewStore((state) => state.activeSessionId);
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
  const syncSessions = useReviewStore((state) => state.syncSessions);
  const closeSession = useReviewStore((state) => state.closeSession);
  const cycleActiveSession = useReviewStore((state) => state.cycleActiveSession);
  const activateTabByOrdinal = useReviewStore((state) => state.activateTabByOrdinal);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  useOverviewShortcut();

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
      // A CLI/`open-file` import wrote a session in main; re-list to surface it.
      bridge.onSessionsChanged(() => void syncSessions()),
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
    syncSessions,
    closeSession,
    cycleActiveSession,
    activateTabByOrdinal,
  ]);

  return (
    <DiffWorkerPool>
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
            <Sidebar>
              {/* Keyed per session so the selector/tree view resets on entry. */}
              {activeSessionId !== null && <SidebarNav key={activeSessionId} />}
            </Sidebar>
          }
        >
          {activeSessionId !== null ? (
            showOverview ? (
              <OverviewScreen />
            ) : (
              <DiffScreen />
            )
          ) : boot === "ready" ? (
            // Only a settled, genuinely session-less boot shows the empty state —
            // it must never flash while sessions are still hydrating.
            <EmptyState onOpenRepository={() => void openRepository()} failure={openFailure} />
          ) : null}
        </AppShell>
      </ReviewDropZone>
    </DiffWorkerPool>
  );
}
