import type { BranchList, GitFailure, LogEntry } from "../../../shared/git";
import type { PatchFile } from "../../../shared/diff/patch";

// The three things a session loads from git, as the phases each of them can be in.
//
// They are a session's shape, not the store's machinery — `SessionSlice` holds one of each,
// and that is how every reader outside the store reaches them: the store defined and exported
// all three, and nothing ever imported one by name. They live here rather than beside the
// slice because the pure functions next to them (`diff-plan.ts`, `log-range.ts`,
// `session-projection.ts`) read these fields, and a lib module importing the store would put
// the dependency the wrong way round: the store is allowed to know about lib, never the
// reverse.

export type DiffState =
  | { phase: "idle" }
  | { phase: "loading" }
  /** loadId is unique per load within a session; key one-shot structures (the
   * tree model) by session id + loadId, since tickets restart per session. */
  | { phase: "loaded"; loadId: number; files: PatchFile[] }
  | { phase: "empty" }
  /** git produced bytes the patch parser could not read — distinct from a clean diff. */
  | { phase: "unreadable" }
  | { phase: "failed"; failure: GitFailure };

export type LogState =
  | { phase: "loading" }
  | { phase: "loaded"; entries: LogEntry[] }
  | { phase: "failed"; failure: GitFailure };

export type BranchesState =
  | { phase: "loading" }
  | { phase: "loaded"; list: BranchList }
  | { phase: "failed"; failure: GitFailure };
