import { BrowserWindow, dialog } from "electron";
import * as z from "zod";
import {
  BranchesResponse,
  DiffRequest,
  DiffResponse,
  FileContentsRequest,
  FileContentsResponse,
  LogRequest,
  LogResponse,
  OpenRepoResponse,
  RepoRequest,
} from "../../shared/git";
import { IpcChannel } from "../../shared/ipc";
import { registerIpcHandler } from "../ipc-registry";
import { getCommitLog, getDiff, getFileContents, listBranches, validateRepo } from "./ops";
import type { GitRunner } from "./runner";

async function openRepoViaDialog(runner: GitRunner): Promise<OpenRepoResponse> {
  const options = {
    title: "Open Repository",
    properties: ["openDirectory" as const],
  };
  // Parented, the dialog is a window-modal sheet on macOS — a second ⌘O cannot
  // stack a parallel dialog over an open one.
  const owner = BrowserWindow.getFocusedWindow();
  const picked = await (owner === null
    ? dialog.showOpenDialog(options)
    : dialog.showOpenDialog(owner, options));
  const directory = picked.filePaths[0];
  if (picked.canceled || directory === undefined) {
    return { ok: true, value: { kind: "canceled" } };
  }
  const repo = await validateRepo(runner, directory);
  if (!repo.ok) return repo;
  return { ok: true, value: { kind: "opened", repo: repo.value } };
}

export function registerGitIpcHandlers(runner: GitRunner): void {
  registerIpcHandler(IpcChannel.repoOpen, { request: z.void(), response: OpenRepoResponse }, () =>
    openRepoViaDialog(runner),
  );

  registerIpcHandler(
    IpcChannel.gitBranches,
    { request: RepoRequest, response: BranchesResponse },
    ({ repoPath }) => listBranches(runner, repoPath),
  );

  registerIpcHandler(
    IpcChannel.gitLog,
    { request: LogRequest, response: LogResponse },
    ({ repoPath, range }) => getCommitLog(runner, repoPath, range),
  );

  registerIpcHandler(
    IpcChannel.gitDiff,
    { request: DiffRequest, response: DiffResponse },
    ({ repoPath, selection }) => getDiff(runner, repoPath, selection),
  );

  registerIpcHandler(
    IpcChannel.gitFileContents,
    { request: FileContentsRequest, response: FileContentsResponse },
    (request) => getFileContents(runner, request),
  );
}
