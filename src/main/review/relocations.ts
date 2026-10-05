import * as z from "zod";
import { RepoPath } from "../../shared/git";
import { appStore } from "../store";

// The one thing relocating a review has to remember: "the artifact says `/home/box/metabase`, and
// on this machine that tree is `~/worktrees/metabase/foo`". Written when a local path was handed
// over (`rvw open --repo`, or Locate Repository…) *and* went live, read before the artifact's own
// path is tried, and pruned once the checkout it points at stops being a repository.
//
// Keyed by the authored path rather than by the artifact, because every review a box writes about
// one checkout names the same path: locating it once answers for all of them, including the ones
// not emitted yet — which is the whole difference between "reopen from Recent Reviews and it is
// still live" and being asked again for every review of the same branch.
//
// An exact map, not a prefix rule (`/home/box/` → `~/`). A prefix rule would also relocate a path
// nobody pointed at, onto a directory that may be a different tree with the same name — and the
// only evidence it was right would be refs that happened to resolve there. Every entry here is a
// pairing a person or `devbox pull` actually made.
//
// One more top-level key in the shared app store (see store.ts), owned here the way `window` is
// owned by window-state.ts — and deliberately not a field of `Settings`: that is the reader's
// preferences, and this is memory the app keeps about the machine, which no settings UI should
// offer to reset.
//
// An interface rather than store calls inline, so the open path tests against a plain map
// (`handlers.test.ts`) instead of pointing the app store at a temp directory per case.

export type RepoRelocations = {
  /** The local toplevel last located for `authored`, or null when there is none. */
  get: (authored: string) => string | null;
  /** Every local toplevel a relocation points at — checkouts the reader has named on this
   * machine, which Review Pull Request… looks among for one of a pull request's repository
   * (`main/pull-request/flow.ts`). */
  locals: () => string[];
  remember: (authored: string, local: string) => void;
  forget: (authored: string) => void;
};

/** The one key this module owns in the shared app store. */
const STORE_KEY = "repoRelocations";

/** Authored path → local toplevel. The values feed `validateRepo` before anything reads them, but
 * they are still disk the app did not write in this run, so they parse like every other owner's
 * keys: a malformed map reads as empty, which costs one Locate rather than a startup. */
const Relocations = z.record(z.string(), RepoPath);
type Relocations = z.infer<typeof Relocations>;

function readRelocations(): Relocations {
  try {
    const result = Relocations.safeParse(appStore().get(STORE_KEY));
    return result.success ? result.data : {};
  } catch (error) {
    console.error("Repository relocations unreadable, starting from none:", error);
    return {};
  }
}

/** Best-effort, like window-state's write: the review already went live, and a failed write only
 * means the next open asks again. `set` rather than a whole-file assignment, so the keys other
 * owners hold ride through untouched. */
function writeRelocations(relocations: Relocations): void {
  try {
    appStore().set(STORE_KEY, relocations);
  } catch (error) {
    console.error("Repository relocations could not be persisted:", error);
  }
}

/** The app's relocations, in the shared app store. */
export function storeRelocations(): RepoRelocations {
  return {
    get: (authored) => readRelocations()[authored] ?? null,
    locals: () => Object.values(readRelocations()),
    remember: (authored, local) => {
      const current = readRelocations();
      if (current[authored] !== local) {
        writeRelocations({ ...current, [authored]: local });
      }
    },
    forget: (authored) => {
      const current = readRelocations();
      if (current[authored] !== undefined) {
        writeRelocations(
          Object.fromEntries(Object.entries(current).filter(([key]) => key !== authored)),
        );
      }
    },
  };
}
