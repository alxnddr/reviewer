import { IpcChannel } from "../shared/ipc";
import { withStoredPin } from "../shared/session";
import { cliStatus, installCli } from "./cli-install";
import { registerGitIpcHandlers } from "./git/handlers";
import { registerIpcHandler } from "./ipc-registry";
import { hasOnboarded, markOnboarded } from "./onboarding";
import { registerReviewIpcHandlers, type ReviewOpenDeps } from "./review/handlers";
import { registerReviewSaveHandlers } from "./review/save";
import { getUserSettings, setUserSettings } from "./user-settings";

export function registerIpcHandlers(
  reviewDeps: ReviewOpenDeps,
  /** Settles once restored reviews are re-pinned (`review/source.ts`). `sessions:list` answers
   * after it, so the renderer never hydrates a pin that is about to change underneath it. */
  sessionsRepinned: Promise<void>,
): void {
  const { runner: gitRunner, store: sessionStore, progress: progressStore } = reviewDeps;

  registerIpcHandler(IpcChannel.settingsGet, () => getUserSettings());

  registerIpcHandler(IpcChannel.settingsSet, (settings) => {
    setUserSettings(settings);
  });

  registerIpcHandler(IpcChannel.cliStatus, () => cliStatus());

  registerIpcHandler(IpcChannel.cliInstall, () => installCli());

  registerIpcHandler(IpcChannel.onboardingGet, () => hasOnboarded());

  registerIpcHandler(IpcChannel.onboardingComplete, () => {
    markOnboarded();
  });

  registerGitIpcHandlers(gitRunner);
  registerReviewIpcHandlers(reviewDeps);
  registerReviewSaveHandlers();

  registerIpcHandler(IpcChannel.sessionsList, async () => {
    await sessionsRepinned;
    return sessionStore.list();
  });

  registerIpcHandler(IpcChannel.sessionsCreate, (request) => sessionStore.create(request.source));

  registerIpcHandler(IpcChannel.sessionsUpdate, (incoming) => {
    const session = withStoredPin(
      incoming,
      sessionStore.list().sessions.find((stored) => stored.id === incoming.id),
    );
    sessionStore.update(session);
    // The session is authoritative while its tab is open; the artifact's record is a mirror
    // of it, so it is refreshed from the same debounced write-back rather than on a channel
    // of its own — one message, one truth, and no way for the two to disagree about what
    // was read. Only review sessions have somewhere to mirror *to*; a plain repo session's
    // progress lives in the session and nowhere else. The store skips writes that did not
    // move the marks, so a scroll costs nothing here.
    if (session.reviewPath !== null) {
      void progressStore.write(session.reviewPath, {
        readFiles: session.readFiles,
        collapsedFiles: session.collapsedFiles,
        readTotal: session.readTotal,
      });
    }
  });

  registerIpcHandler(IpcChannel.sessionsDelete, (request) => {
    sessionStore.delete(request.id);
  });

  registerIpcHandler(IpcChannel.sessionsSetActive, (request) => {
    sessionStore.setActive(request.id);
  });

  registerIpcHandler(IpcChannel.sessionsReorder, (request) => {
    sessionStore.reorder(request.ids);
  });
}
