import type { CliInstallResult, CliStatus } from "./cli";
import type { ThemeId } from "./contracts";
import type {
  BranchesResponse,
  DiffRequest,
  DiffResponse,
  FileContentsRequest,
  FileContentsResponse,
  LogRequest,
  LogResponse,
  OpenRepoResponse,
  RepoRequest,
} from "./git";
import type { RecentReviewsResponse } from "./recent-reviews";
import type { ReviewOpenPathRequest, ReviewOpenResponse } from "./review-open";
import type { ReviewSaveRequest, ReviewSaveResponse } from "./review-save";
import type {
  Session,
  SessionCreateRequest,
  SessionIdRequest,
  SessionOrderRequest,
  SessionSnapshot,
} from "./session";

// Runtime-light on purpose: the sandboxed preload bundles this module, so it must
// not pull zod in — schemas live in contracts.ts / git.ts and are imported as types
// only. Main pairs each channel with its schemas via registerIpcHandler.
export const IpcChannel = {
  themeGet: "theme:get",
  themeSet: "theme:set",
  // The `rvw` launcher, as the first-run guide needs it: where it stands, and the one
  // button that changes that. The install runs in main because it writes outside the app
  // and asks the OS for admin rights to do it.
  cliStatus: "cli:status",
  cliInstall: "cli:install",
  // The first-run guide's one bit of memory, kept beside the theme in app settings.
  onboardingGet: "onboarding:get",
  onboardingComplete: "onboarding:complete",
  repoOpen: "repo:open",
  // The dialog path shows the picker in main and answers through the invoke; the
  // path variant guards a renderer-supplied (dropped) path. Both hit one guard.
  reviewOpen: "review:open",
  reviewOpenPath: "review:open-path",
  // What `rvw emit` has left in its managed directory, for the recents picker. A read of
  // one folder in main; the renderer never sees a filesystem.
  reviewsRecent: "reviews:recent",
  // Export the curated review: the renderer serializes it (pure generators) and
  // main shows the native save sheet + writes. One channel per format so each
  // carries its own filter and default filename; both share the write seam.
  reviewSaveJson: "review:save-json",
  reviewSaveMarkdown: "review:save-markdown",
  gitBranches: "git:branches",
  gitLog: "git:log",
  gitDiff: "git:diff",
  // Full text of a file at a ref, for expanding the unchanged lines around a hunk.
  // Modelled on git:diff so the validated boundary + envelope carry over.
  gitFileContents: "git:file-contents",
  sessionsList: "sessions:list",
  sessionsCreate: "sessions:create",
  sessionsUpdate: "sessions:update",
  sessionsDelete: "sessions:delete",
  sessionsSetActive: "sessions:set-active",
  sessionsReorder: "sessions:reorder",
} as const;
export type IpcChannelName = (typeof IpcChannel)[keyof typeof IpcChannel];

/** Main→renderer pushes. Payload-free by design: a menu click is a command, not
 * data, so nothing needs validation and renderer→main stays invoke-only.
 * The ⌘1…⌘9 tab jumps are nine separate channels for the same reason — the
 * ordinal is the channel, never a payload. */
export const IpcEvent = {
  menuOpenRepo: "menu:open-repo",
  menuOpenReview: "menu:open-review",
  // Toggles the in-app recents picker. A command like the rest of these — the list it shows
  // is read by the renderer over `reviews:recent`, not carried on the event.
  menuOpenRecentReviews: "menu:open-recent-reviews",
  // Export commands: like the open commands they carry no data — the
  // renderer owns the serialize→save flow the same way it owns the open flow.
  menuExportReviewJson: "menu:export-review-json",
  menuExportReviewMarkdown: "menu:export-review-markdown",
  // The prompt copies (⇧⌘C / ⌥⇧⌘C). Menu commands rather than renderer key handlers so
  // the chord fires whatever holds focus — including inside the diff's shadow root — and
  // so the accelerator and the menu item cannot drift from each other. Payload-free like
  // the rest: which comment is "the one you are on" is the renderer's own state.
  menuCopyCommentPrompt: "menu:copy-comment-prompt",
  menuCopyAllCommentsPrompt: "menu:copy-all-comments-prompt",
  // This main→renderer event carries no data: a CLI/`open-file` import writes the
  // session in main, then fires this so the renderer re-lists via `sessions:list`.
  // The imported path/model never crosses the bridge.
  sessionsChanged: "sessions:changed",
  menuCloseTab: "menu:close-tab",
  menuNextTab: "menu:next-tab",
  menuPreviousTab: "menu:previous-tab",
  menuActivateTab1: "menu:activate-tab-1",
  menuActivateTab2: "menu:activate-tab-2",
  menuActivateTab3: "menu:activate-tab-3",
  menuActivateTab4: "menu:activate-tab-4",
  menuActivateTab5: "menu:activate-tab-5",
  menuActivateTab6: "menu:activate-tab-6",
  menuActivateTab7: "menu:activate-tab-7",
  menuActivateTab8: "menu:activate-tab-8",
  menuActivateTab9: "menu:activate-tab-9",
} as const;
export type IpcEventName = (typeof IpcEvent)[keyof typeof IpcEvent];

/** The 1-based tab position a ⌘-digit accelerator names; 9 means the last tab
 * (macOS tabbed-app convention), which the store resolves. */
export type TabOrdinal = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

export type TabCycleDirection = "next" | "previous";

/** An ordinal may only pair with its own channel — a mispaired entry (say,
 * `[1, menuActivateTab2]`) fails to typecheck. */
type TabOrdinalEventPair = {
  [Ordinal in TabOrdinal]: readonly [Ordinal, `menu:activate-tab-${Ordinal}`];
}[TabOrdinal];

/** Ordinal ↔ channel pairing shared by the menu (send side) and the preload
 * (subscribe side), so neither can drift from the other. */
export const TAB_ORDINAL_EVENTS = [
  [1, IpcEvent.menuActivateTab1],
  [2, IpcEvent.menuActivateTab2],
  [3, IpcEvent.menuActivateTab3],
  [4, IpcEvent.menuActivateTab4],
  [5, IpcEvent.menuActivateTab5],
  [6, IpcEvent.menuActivateTab6],
  [7, IpcEvent.menuActivateTab7],
  [8, IpcEvent.menuActivateTab8],
  [9, IpcEvent.menuActivateTab9],
] as const satisfies ReadonlyArray<TabOrdinalEventPair>;

/** Single source of truth linking each channel to its wire types; main handlers and
 * the preload bridge are both typechecked against it. */
export type IpcContract = {
  "theme:get": { request: void; response: ThemeId };
  "theme:set": { request: ThemeId; response: void };
  "cli:status": { request: void; response: CliStatus };
  // Answers with the state *after* the attempt rather than a bare success flag: the guide
  // shows where the launcher landed, and "installed" is a fact on disk either way.
  "cli:install": { request: void; response: CliInstallResult };
  "onboarding:get": { request: void; response: boolean };
  "onboarding:complete": { request: void; response: void };
  "repo:open": { request: void; response: OpenRepoResponse };
  // Dialog: main owns the picker, so the request is void. Path: the renderer
  // supplies the dropped path, guarded in main before use.
  "review:open": { request: void; response: ReviewOpenResponse };
  "review:open-path": { request: ReviewOpenPathRequest; response: ReviewOpenResponse };
  // Answers plainly rather than in a result envelope: "the directory would not open" is a
  // field on the answer (see RecentReviewsResponse), not a failed call.
  "reviews:recent": { request: void; response: RecentReviewsResponse };
  "review:save-json": { request: ReviewSaveRequest; response: ReviewSaveResponse };
  "review:save-markdown": { request: ReviewSaveRequest; response: ReviewSaveResponse };
  "git:branches": { request: RepoRequest; response: BranchesResponse };
  "git:log": { request: LogRequest; response: LogResponse };
  "git:diff": { request: DiffRequest; response: DiffResponse };
  "git:file-contents": { request: FileContentsRequest; response: FileContentsResponse };
  // Session channels answer plainly, not in the GitResult envelope: no git runs
  // here and the store's salvage-on-load semantics mean reads always succeed.
  "sessions:list": { request: void; response: SessionSnapshot };
  "sessions:create": { request: SessionCreateRequest; response: Session };
  "sessions:update": { request: Session; response: void };
  "sessions:delete": { request: SessionIdRequest; response: void };
  "sessions:set-active": { request: SessionIdRequest; response: void };
  "sessions:reorder": { request: SessionOrderRequest; response: void };
};

export type IpcRequest<Channel extends IpcChannelName> = IpcContract[Channel]["request"];
export type IpcResponse<Channel extends IpcChannelName> = IpcContract[Channel]["response"];

export type ReviewerBridge = {
  getThemeSelection: () => Promise<IpcResponse<"theme:get">>;
  setThemeSelection: (selection: IpcRequest<"theme:set">) => Promise<void>;
  /** Whether `rvw` is on the box, and where it goes — re-read on every call. */
  getCliStatus: () => Promise<IpcResponse<"cli:status">>;
  /** Installs the `rvw` launcher (one admin prompt); resolves with where that left it. */
  installCli: () => Promise<IpcResponse<"cli:install">>;
  /** Whether the first-run guide has been through once. */
  getOnboarded: () => Promise<IpcResponse<"onboarding:get">>;
  /** Records that it has — finished or skipped, which are the same thing to the reader. */
  completeOnboarding: () => Promise<IpcResponse<"onboarding:complete">>;
  openRepo: () => Promise<IpcResponse<"repo:open">>;
  /** File → Open Review…: main shows the native picker and guards the pick. */
  openReview: () => Promise<IpcResponse<"review:open">>;
  /** A dropped review: `path` comes from `getPathForFile`, guarded in main. */
  openReviewByPath: (
    request: IpcRequest<"review:open-path">,
  ) => Promise<IpcResponse<"review:open-path">>;
  /** The reviews `rvw emit` has written, newest first, for the recents picker. Re-read on
   * every call: the CLI writes into that directory while the app is running, which is the
   * whole point of it, so a cached list would be stale by the time it is looked at. */
  listRecentReviews: () => Promise<IpcResponse<"reviews:recent">>;
  /** Export the curated review as `.reviewer.json`: main shows the save sheet and
   * writes the serialized artifact the renderer passes. */
  saveReviewJson: (
    request: IpcRequest<"review:save-json">,
  ) => Promise<IpcResponse<"review:save-json">>;
  /** Export the curated review as Markdown: same save seam, Markdown filter. */
  saveReviewMarkdown: (
    request: IpcRequest<"review:save-markdown">,
  ) => Promise<IpcResponse<"review:save-markdown">>;
  /** Resolves a dropped File to its disk path via `webUtils` (preload-only, never
   * the renderer); null when the File is not backed by a file on disk. */
  getPathForFile: (file: File) => string | null;
  listBranches: (request: IpcRequest<"git:branches">) => Promise<IpcResponse<"git:branches">>;
  getCommitLog: (request: IpcRequest<"git:log">) => Promise<IpcResponse<"git:log">>;
  getDiff: (request: IpcRequest<"git:diff">) => Promise<IpcResponse<"git:diff">>;
  /** Full text of a file at a ref, for context expansion; mirrors getDiff. */
  getFileContents: (
    request: IpcRequest<"git:file-contents">,
  ) => Promise<IpcResponse<"git:file-contents">>;
  listSessions: () => Promise<IpcResponse<"sessions:list">>;
  createSession: (
    request: IpcRequest<"sessions:create">,
  ) => Promise<IpcResponse<"sessions:create">>;
  /** The debounced write-back sink: the renderer's hydrated copy flows back here. */
  updateSession: (
    session: IpcRequest<"sessions:update">,
  ) => Promise<IpcResponse<"sessions:update">>;
  deleteSession: (
    request: IpcRequest<"sessions:delete">,
  ) => Promise<IpcResponse<"sessions:delete">>;
  setActiveSession: (
    request: IpcRequest<"sessions:set-active">,
  ) => Promise<IpcResponse<"sessions:set-active">>;
  /** Persists the tab strip's order after a drag, so an arrangement survives restart. */
  reorderSessions: (
    request: IpcRequest<"sessions:reorder">,
  ) => Promise<IpcResponse<"sessions:reorder">>;
  /** Subscribes to the File → Open Repository menu command; returns unsubscribe. */
  onOpenRepoCommand: (listener: () => void) => () => void;
  /** Subscribes to the File → Open Review… menu command; returns unsubscribe. */
  onOpenReviewCommand: (listener: () => void) => () => void;
  /** Subscribes to the File → Recent Reviews command (⇧⌘R); returns unsubscribe. */
  onOpenRecentReviewsCommand: (listener: () => void) => () => void;
  /** Subscribes to the File → Export Review (.reviewer.json) command; unsubscribe. */
  onExportReviewJsonCommand: (listener: () => void) => () => void;
  /** Subscribes to the File → Export Review as Markdown command; unsubscribe. */
  onExportReviewMarkdownCommand: (listener: () => void) => () => void;
  /** Subscribes to Copy Comment as Prompt (⇧⌘C); returns unsubscribe. */
  onCopyCommentPromptCommand: (listener: () => void) => () => void;
  /** Subscribes to Copy All Comments as Prompt (⌥⇧⌘C); returns unsubscribe. */
  onCopyAllCommentsPromptCommand: (listener: () => void) => () => void;
  /** Subscribes to the payload-free push fired after a CLI/`open-file` import
   * wrote a session; the listener re-lists (`sessions:list`). Returns unsubscribe. */
  onSessionsChanged: (listener: () => void) => () => void;
  /** Subscribes to the ⌘W Close Tab menu command; returns unsubscribe. */
  onCloseTabCommand: (listener: () => void) => () => void;
  /** Subscribes to the ⌃Tab / ⌃⇧Tab cycle commands; the direction is derived
   * from the channel in the preload, not read off the wire. */
  onCycleTabCommand: (listener: (direction: TabCycleDirection) => void) => () => void;
  /** Subscribes to the ⌘1…⌘9 jump commands; the ordinal is derived from the
   * channel in the preload, not read off the wire. */
  onActivateTabCommand: (listener: (ordinal: TabOrdinal) => void) => () => void;
};
