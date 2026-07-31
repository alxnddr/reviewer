import { IpcChannel } from "../shared/ipc";
import { cliStatus, installCli } from "./cli-install";
import { registerGitIpcHandlers } from "./git/handlers";
import type { GitRunner } from "./git/runner";
import { registerIpcHandler } from "./ipc-registry";
import { hasOnboarded, markOnboarded } from "./onboarding";
import { registerReviewIpcHandlers } from "./review/handlers";
import type { ProgressStore } from "./review/progress";
import { registerReviewSaveHandlers } from "./review/save";
import type { SessionStore } from "./sessions";
import { getThemeSelection, setThemeSelection } from "./theme";

export function registerIpcHandlers(
  gitRunner: GitRunner,
  sessionStore: SessionStore,
  progressStore: ProgressStore,
): void {
  registerIpcHandler(IpcChannel.themeGet, () => {
    return getThemeSelection();
  });

  registerIpcHandler(IpcChannel.themeSet, (selection) => {
    setThemeSelection(selection);
  });

  registerIpcHandler(IpcChannel.cliStatus, () => cliStatus());

  registerIpcHandler(IpcChannel.cliInstall, () => installCli());

  registerIpcHandler(IpcChannel.onboardingGet, () => hasOnboarded());

  registerIpcHandler(IpcChannel.onboardingComplete, () => {
    markOnboarded();
  });

  registerGitIpcHandlers(gitRunner);
  registerReviewIpcHandlers(gitRunner, sessionStore, progressStore);
  registerReviewSaveHandlers();

  registerIpcHandler(IpcChannel.sessionsList, () => sessionStore.list());

  registerIpcHandler(IpcChannel.sessionsCreate, (request) => sessionStore.create(request.source));

  registerIpcHandler(IpcChannel.sessionsUpdate, (session) => {
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
