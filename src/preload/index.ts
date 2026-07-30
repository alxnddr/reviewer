import { contextBridge, ipcRenderer, webUtils } from "electron";
import {
  IpcChannel,
  IpcEvent,
  TAB_ORDINAL_EVENTS,
  type IpcChannelName,
  type IpcEventName,
  type IpcRequest,
  type IpcResponse,
  type ReviewerBridge,
} from "../shared/ipc";

// ipcRenderer.invoke returns Promise<any>; this wrapper is what actually ties each
// channel to its contract types, so a channel/payload mix-up fails to compile.
function invoke<Channel extends IpcChannelName>(
  channel: Channel,
  request: IpcRequest<Channel>,
): Promise<IpcResponse<Channel>> {
  return ipcRenderer.invoke(channel, request);
}

/** Menu commands are payload-free: the electron event object is dropped
 * so renderer-side listener signatures stay free of electron types, and any
 * meaning (direction, ordinal) is derived here from the channel constant. */
function subscribeCommand(event: IpcEventName, listener: () => void): () => void {
  const subscription = (): void => listener();
  ipcRenderer.on(event, subscription);
  return () => {
    ipcRenderer.off(event, subscription);
  };
}

const bridge: ReviewerBridge = {
  getThemeSelection: () => invoke(IpcChannel.themeGet, undefined),
  setThemeSelection: (selection) => invoke(IpcChannel.themeSet, selection),
  getCliStatus: () => invoke(IpcChannel.cliStatus, undefined),
  installCli: () => invoke(IpcChannel.cliInstall, undefined),
  getOnboarded: () => invoke(IpcChannel.onboardingGet, undefined),
  completeOnboarding: () => invoke(IpcChannel.onboardingComplete, undefined),
  openRepo: () => invoke(IpcChannel.repoOpen, undefined),
  openReview: () => invoke(IpcChannel.reviewOpen, undefined),
  openReviewByPath: (request) => invoke(IpcChannel.reviewOpenPath, request),
  listRecentReviews: () => invoke(IpcChannel.reviewsRecent, undefined),
  saveReviewJson: (request) => invoke(IpcChannel.reviewSaveJson, request),
  saveReviewMarkdown: (request) => invoke(IpcChannel.reviewSaveMarkdown, request),
  // webUtils stays in the sandboxed preload, never the renderer. A File
  // built in JS (not backed by disk) yields "" — surfaced as null so the caller
  // never invokes with an empty path.
  getPathForFile: (file) => {
    const path = webUtils.getPathForFile(file);
    return path === "" ? null : path;
  },
  listBranches: (request) => invoke(IpcChannel.gitBranches, request),
  getCommitLog: (request) => invoke(IpcChannel.gitLog, request),
  getDiff: (request) => invoke(IpcChannel.gitDiff, request),
  getFileContents: (request) => invoke(IpcChannel.gitFileContents, request),
  listSessions: () => invoke(IpcChannel.sessionsList, undefined),
  createSession: (request) => invoke(IpcChannel.sessionsCreate, request),
  updateSession: (session) => invoke(IpcChannel.sessionsUpdate, session),
  deleteSession: (request) => invoke(IpcChannel.sessionsDelete, request),
  setActiveSession: (request) => invoke(IpcChannel.sessionsSetActive, request),
  reorderSessions: (request) => invoke(IpcChannel.sessionsReorder, request),
  onOpenRepoCommand: (listener) => subscribeCommand(IpcEvent.menuOpenRepo, listener),
  onOpenReviewCommand: (listener) => subscribeCommand(IpcEvent.menuOpenReview, listener),
  onOpenRecentReviewsCommand: (listener) =>
    subscribeCommand(IpcEvent.menuOpenRecentReviews, listener),
  onExportReviewJsonCommand: (listener) =>
    subscribeCommand(IpcEvent.menuExportReviewJson, listener),
  onExportReviewMarkdownCommand: (listener) =>
    subscribeCommand(IpcEvent.menuExportReviewMarkdown, listener),
  onCopyCommentPromptCommand: (listener) =>
    subscribeCommand(IpcEvent.menuCopyCommentPrompt, listener),
  onCopyAllCommentsPromptCommand: (listener) =>
    subscribeCommand(IpcEvent.menuCopyAllCommentsPrompt, listener),
  onSessionsChanged: (listener) => subscribeCommand(IpcEvent.sessionsChanged, listener),
  onCloseTabCommand: (listener) => subscribeCommand(IpcEvent.menuCloseTab, listener),
  onCycleTabCommand: (listener) => {
    const unsubscribes = [
      subscribeCommand(IpcEvent.menuNextTab, () => listener("next")),
      subscribeCommand(IpcEvent.menuPreviousTab, () => listener("previous")),
    ];
    return () => {
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
    };
  },
  onActivateTabCommand: (listener) => {
    const unsubscribes = TAB_ORDINAL_EVENTS.map(([ordinal, event]) =>
      subscribeCommand(event, () => listener(ordinal)),
    );
    return () => {
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
    };
  },
};

contextBridge.exposeInMainWorld("reviewer", bridge);
