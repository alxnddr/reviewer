import { create, type StoreApi, type UseBoundStore } from "zustand";
import type { GitHubSetTokenResponse, GitHubStatus } from "../../../shared/github-posting";

// The reader's GitHub tokens, as the renderer knows them: described, never held. Main keeps every
// token in memory (`main/github/credentials.ts`) and answers with kind, login, owner and expiry;
// this store keeps that description for the two places that read it — Settings ▸ GitHub, which
// lists the tokens and offers to forget one, and the comment cards, which draw Post only when a
// token covers the review's pull request (`lib/github-posting.ts`'s `tokenCovers`).
//
// **The token passes through, never stays.** `setToken` hands the pasted text straight to the
// bridge and keeps nothing; what it keeps is main's answer, which has no field for a token. The
// field it came from clears itself (`components/settings/GitHubTokens.tsx`).
//
// Its own store rather than a review slice for the settings store's reason: nothing here belongs
// to a session, and the tokens are main's for the whole app.

type GitHubState = {
  /** What main holds, or null until it has answered. */
  status: GitHubStatus | null;
  /** Ask main again — at launch, and whenever Settings opens. */
  load: () => Promise<void>;
  /** Hand a pasted token to main to check and keep. Answers main's answer, which describes the
   * token or says why not; the status is re-read either way. */
  setToken: (token: string, owner: string | undefined) => Promise<GitHubSetTokenResponse>;
  /** Forget one token: the one for `owner`, or the classic one (null). */
  forget: (owner: string | null) => Promise<void>;
};

export type GitHubStore = UseBoundStore<StoreApi<GitHubState>>;

export function createGitHubStore(): GitHubStore {
  return create<GitHubState>((set, get) => ({
    status: null,

    load: async () => {
      const bridge = window.reviewer;
      if (!bridge) {
        return;
      }
      try {
        set({ status: await bridge.getGitHubStatus() });
      } catch (error) {
        console.error("Reading the GitHub token status failed:", error);
      }
    },

    setToken: async (token, owner) => {
      const bridge = window.reviewer;
      if (!bridge) {
        return { ok: false, failure: { code: "unexpected" }, clipboardCleared: false };
      }
      let answer: GitHubSetTokenResponse;
      try {
        answer = await bridge.setGitHubToken(owner === undefined ? { token } : { token, owner });
      } catch {
        // Not the error: it was thrown by a call that was handed the token, and an IPC error's
        // message can quote the request it failed on.
        console.error("Handing the GitHub token to main failed.");
        answer = { ok: false, failure: { code: "unexpected" }, clipboardCleared: false };
      }
      await get().load();
      return answer;
    },

    forget: async (owner) => {
      const bridge = window.reviewer;
      if (!bridge) {
        return;
      }
      try {
        set({ status: await bridge.forgetGitHubToken({ owner }) });
      } catch (error) {
        console.error("Forgetting the GitHub token failed:", error);
      }
    },
  }));
}

/** The app's one instance; tests build their own. */
export const useGitHubStore: GitHubStore = createGitHubStore();
