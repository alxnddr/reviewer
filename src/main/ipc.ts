import * as z from "zod";
import { CliInstallResult, CliStatus } from "../shared/cli";
import { ThemeId } from "../shared/contracts";
import { IpcChannel } from "../shared/ipc";
import {
  Session,
  SessionCreateRequest,
  SessionIdRequest,
  SessionOrderRequest,
  SessionSnapshot,
} from "../shared/session";
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
  registerIpcHandler(IpcChannel.themeGet, { request: z.void(), response: ThemeId }, () => {
    return getThemeSelection();
  });

  registerIpcHandler(IpcChannel.themeSet, { request: ThemeId, response: z.void() }, (selection) => {
    setThemeSelection(selection);
  });

  registerIpcHandler(IpcChannel.cliStatus, { request: z.void(), response: CliStatus }, () =>
    cliStatus(),
  );

  registerIpcHandler(IpcChannel.cliInstall, { request: z.void(), response: CliInstallResult }, () =>
    installCli(),
  );

  registerIpcHandler(IpcChannel.onboardingGet, { request: z.void(), response: z.boolean() }, () =>
    hasOnboarded(),
  );

  registerIpcHandler(
    IpcChannel.onboardingComplete,
    { request: z.void(), response: z.void() },
    () => {
      markOnboarded();
    },
  );

  registerGitIpcHandlers(gitRunner);
  registerReviewIpcHandlers(gitRunner, sessionStore, progressStore);
  registerReviewSaveHandlers();

  registerIpcHandler(
    IpcChannel.sessionsList,
    { request: z.void(), response: SessionSnapshot },
    () => sessionStore.list(),
  );

  registerIpcHandler(
    IpcChannel.sessionsCreate,
    { request: SessionCreateRequest, response: Session },
    (request) => sessionStore.create(request.source),
  );

  registerIpcHandler(
    IpcChannel.sessionsUpdate,
    { request: Session, response: z.void() },
    (session) => {
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
    },
  );

  registerIpcHandler(
    IpcChannel.sessionsDelete,
    { request: SessionIdRequest, response: z.void() },
    (request) => {
      sessionStore.delete(request.id);
    },
  );

  registerIpcHandler(
    IpcChannel.sessionsSetActive,
    { request: SessionIdRequest, response: z.void() },
    (request) => {
      sessionStore.setActive(request.id);
    },
  );

  registerIpcHandler(
    IpcChannel.sessionsReorder,
    { request: SessionOrderRequest, response: z.void() },
    (request) => {
      sessionStore.reorder(request.ids);
    },
  );
}
