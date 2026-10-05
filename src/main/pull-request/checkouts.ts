import * as z from "zod";
import { RepoPath } from "../../shared/git";
import type { PullRequest } from "../../shared/pull-request";
import { appStore } from "../store";

// The one thing Review Pull Request… has to remember between runs: "the checkout of
// `acme/widget` on this machine is `~/code/widget`". Written when the reader answers the
// question the app could not — a directory picked through Locate Repository…, or a fresh clone
// — and read first the next time a pull request of the same repository is pasted, so they are
// asked once per repository rather than once per pull request.
//
// Not written for a checkout the app found on its own among the ones it already knows: that
// search is cheap and runs again next time, and a remembered answer outranks it — remembering
// every match would freeze whichever of two clones happened to be found first.
//
// One more top-level key in the shared app store (`main/store.ts`), owned here the way
// `repoRelocations` is owned by `review/relocations.ts`, whose shape this mirrors on purpose.
// Not a field of `Settings`: this is memory the app keeps about the machine, not a preference,
// and no settings row should offer to reset it. Not `repoRelocations` itself either, although
// both map to a local checkout: a relocation is keyed by a path some *artifact* wrote, and this
// by a repository's name on GitHub — two different questions, and a stale answer to one must
// not be served as an answer to the other.
//
// An interface rather than store calls inline, so the flow tests against a plain map
// (`flow.test.ts`) rather than an electron-store in a temp directory.

export type CheckoutMemory = {
  /** The checkout last chosen for the pull request's repository, or null. */
  get: (pr: PullRequest) => string | null;
  remember: (pr: PullRequest, checkout: string) => void;
  forget: (pr: PullRequest) => void;
};

/** The one key this module owns in the shared app store. */
const STORE_KEY = "pullRequestCheckouts";

/** `github.com/acme/widget`, lowercased: GitHub's names are case-insensitive, so the spellings
 * a reader pastes on two different days are one repository and one entry. A value-returning
 * switch on the host, so a second host is a compile error here rather than a key collision. */
export function checkoutKey(pr: PullRequest): string {
  switch (pr.host) {
    case "github.com":
      return `${pr.host}/${pr.owner}/${pr.repo}`.toLowerCase();
  }
}

/** Repository → local checkout. The values are disk the app did not write in this run and feed
 * `validateRepo` before anything reads them; they parse like every other owner's keys, so a
 * malformed map reads as empty — which costs one Locate, never a startup. */
const Checkouts = z.record(z.string(), RepoPath);
type Checkouts = z.infer<typeof Checkouts>;

function readCheckouts(): Checkouts {
  try {
    const result = Checkouts.safeParse(appStore().get(STORE_KEY));
    return result.success ? result.data : {};
  } catch (error) {
    console.error("Pull request checkouts unreadable, starting from none:", error);
    return {};
  }
}

/** Best-effort, like the relocations' write: the checkout is already in use, and a lost write
 * only means the next pull request of this repository asks again. `set` of the one key, so the
 * keys other owners hold ride through untouched. */
function writeCheckouts(checkouts: Checkouts): void {
  try {
    appStore().set(STORE_KEY, checkouts);
  } catch (error) {
    console.error("Pull request checkouts could not be persisted:", error);
  }
}

/** The app's remembered checkouts, in the shared app store. */
export function storeCheckouts(): CheckoutMemory {
  return {
    get: (pr) => readCheckouts()[checkoutKey(pr)] ?? null,
    remember: (pr, checkout) => {
      const current = readCheckouts();
      const key = checkoutKey(pr);
      if (current[key] !== checkout) {
        writeCheckouts({ ...current, [key]: checkout });
      }
    },
    forget: (pr) => {
      const current = readCheckouts();
      const key = checkoutKey(pr);
      if (current[key] !== undefined) {
        writeCheckouts(Object.fromEntries(Object.entries(current).filter(([k]) => k !== key)));
      }
    },
  };
}
