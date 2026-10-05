import { app, clipboard } from "electron";
import { IpcChannel } from "../../shared/ipc";
import type { GitHubResult } from "../../shared/github-ipc";
import type { GitHubPostAnswer, GitHubStatus } from "../../shared/github-posting";
import { resolveSettings, type Settings } from "../../shared/settings";
import type { Session } from "../../shared/session";
import { registerIpcHandler } from "../ipc-registry";
import type { ProgressStore } from "../review/progress";
import type { GitHubClient } from "./client";
import { acceptToken, createCredentialVault } from "./credentials";
import { createDiffChecker } from "./diff-check";
import { exposingSwitches } from "./exposure";
import { createPoster } from "./posting";
import { createPullRequestReader, listReviewRequests, wireInfo } from "./rest";

// The GitHub rows of the IPC table. Everything that decides anything is in `client.ts`,
// `rest.ts`, `diff-check.ts`, `credentials.ts` and `posting.ts`, which run without
// Electron; this file only binds them to their channels and to Electron — the registry has
// already checked the sender and parsed the request, and parses the answer on the way out.
//
// **The inbox stays anonymous** even with a token: a token makes `@me` resolve, but the reader's
// login is already in Settings, and a fine-grained token covers one owner — searching with it
// would quietly narrow the inbox to that owner's repositories (fine-grained tokens see only what
// they were granted) for no gain the username does not already give. B4's diff check and B3's
// lookup use the token for the pull request's owner when there is one: that is what reaches a
// private repository.

/** An unexpected throw — a bug, not an answer GitHub gave — as a typed failure, so no rejected
 * promise crosses the bridge. The log line names the channel and the error, and nothing a
 * request carried: the rule `client.ts` sets for credentials holds here too. */
async function settled<Answer extends GitHubResult<unknown> | GitHubPostAnswer<unknown>>(
  channel: string,
  task: () => Promise<Answer>,
): Promise<Answer | { ok: false; failure: { code: "unexpected" } }> {
  try {
    return await task();
  } catch (error) {
    console.error(`${channel} failed unexpectedly:`, error);
    return { ok: false, failure: { code: "unexpected" } };
  }
}

export type GitHubHandlerDeps = {
  client: GitHubClient;
  /** The sessions main persists — what posting reads every body from. */
  sessions: () => readonly Session[];
  progress: ProgressStore;
  /** The reader's stored settings, read at the moment they matter. */
  settings: () => Settings;
};

export function registerGitHubIpcHandlers(deps: GitHubHandlerDeps): void {
  const { client } = deps;
  // One pull request reader for the dialog's lookup, the diff check and posting, so they share
  // its short memo (`rest.ts`'s `createPullRequestReader` says why) — keyed by who asked.
  const readPullRequest = createPullRequestReader(client);
  const checker = createDiffChecker(client, readPullRequest);
  // The tokens, in memory until quit (`credentials.ts`).
  const vault = createCredentialVault();
  // Read once: a run's switches do not change under it (`exposure.ts`).
  const exposed = exposingSwitches({
    packaged: app.isPackaged,
    hasSwitch: (name) => app.commandLine.hasSwitch(name),
    argv: process.argv,
    env: process.env,
  });
  const exposedBy = (): readonly string[] => exposed;
  const resolved = (): ReturnType<typeof resolveSettings> =>
    // `systemDark` decides only the theme, which nothing here reads.
    resolveSettings(deps.settings(), { systemDark: false });
  const poster = createPoster({
    client,
    vault,
    readPullRequest,
    indexAt: checker.indexAt,
    findSession: (id) => deps.sessions().find((session) => session.id === id),
    records: {
      read: (path) => deps.progress.readPosted(path),
      write: (path, record) => deps.progress.writePosted(path, record),
    },
    includeEvidence: () => resolved().postableIncludesEvidence,
    exposedBy,
  });
  const status = (): GitHubStatus => ({
    tokens: vault.status(),
    exposedBy: [...exposed],
  });

  registerIpcHandler(IpcChannel.githubInbox, ({ login }) =>
    settled(IpcChannel.githubInbox, () => listReviewRequests(client, login)),
  );
  registerIpcHandler(IpcChannel.githubPullRequest, ({ pullRequest }) =>
    settled(IpcChannel.githubPullRequest, async () => {
      const auth = vault.authFor(pullRequest.owner) ?? undefined;
      const read = await readPullRequest(pullRequest, auth === undefined ? {} : { auth });
      return read.ok ? { ok: true, value: wireInfo(read.value) } : read;
    }),
  );
  registerIpcHandler(IpcChannel.githubCheckDiff, (request) =>
    settled(IpcChannel.githubCheckDiff, () =>
      checker.check(request, vault.authFor(request.pullRequest.owner) ?? undefined),
    ),
  );

  // `acceptToken` answers every outcome, a throw included, without logging the token.
  registerIpcHandler(IpcChannel.githubSetToken, ({ token, owner }) =>
    acceptToken({ client, vault, clipboard, exposedBy }, token, owner),
  );
  registerIpcHandler(IpcChannel.githubStatus, () => status());
  registerIpcHandler(IpcChannel.githubForgetToken, ({ owner }) => {
    vault.forget(owner);
    return status();
  });
  registerIpcHandler(IpcChannel.githubPostComments, (request) =>
    settled(IpcChannel.githubPostComments, () => poster.post(request)),
  );
  registerIpcHandler(IpcChannel.githubPosted, ({ sessionId }) =>
    settled(IpcChannel.githubPosted, () => poster.posted(sessionId)),
  );
  registerIpcHandler(IpcChannel.githubDeletePendingComment, (request) =>
    settled(IpcChannel.githubDeletePendingComment, () => poster.remove(request)),
  );
}
