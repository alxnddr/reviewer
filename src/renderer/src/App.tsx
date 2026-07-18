import { useEffect, type ReactElement } from "react";
import { AppShell } from "@/components/AppShell";
import { DiffScreen } from "@/components/DiffScreen";
import { DiffWorkerPool } from "@/components/DiffWorkerPool";
import { EmptyState } from "@/components/EmptyState";
import { OpenFailureBanner } from "@/components/OpenFailureBanner";
import { ReviewDropZone } from "@/components/ReviewDropZone";
import { ReviewExportFailureBanner } from "@/components/ReviewExportFailureBanner";
import { ReviewOpenFailureBanner } from "@/components/ReviewOpenFailureBanner";
import { Sidebar } from "@/components/Sidebar";
import { SidebarNav } from "@/components/SidebarNav";
import { useReviewStore } from "@/stores/review";

export function App(): ReactElement {
  const boot = useReviewStore((state) => state.boot);
  const activeSessionId = useReviewStore((state) => state.activeSessionId);
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
            <DiffScreen />
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
