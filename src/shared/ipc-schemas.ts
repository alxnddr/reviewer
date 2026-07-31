import * as z from "zod";
import { CliInstallResult, CliStatus } from "./cli";
import { ThemeId } from "./contracts";
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
} from "./git";
import type { IpcChannelName } from "./ipc";
import {
  RecentReviewsResponse,
  ReviewOpenPathRequest,
  ReviewOpenResponse,
  ReviewSaveRequest,
  ReviewSaveResponse,
} from "./review-ipc";
import {
  Session,
  SessionCreateRequest,
  SessionIdRequest,
  SessionOrderRequest,
  SessionSnapshot,
} from "./session";

// One row per channel, and the only place a channel's payload shapes are written down: main
// validates with these schemas (`ipc-registry.ts` looks them up by channel) and `IpcContract`
// below is `z.infer` of the same objects, so the types the renderer compiles against and the
// checks the boundary actually performs are one declaration. A handler can no longer be
// registered against a schema that is not its channel's — there is no second schema to pass.
//
// Split out from `ipc.ts` rather than living in it because this is the one part of the contract
// that holds zod at runtime: `ipc.ts` takes `IpcContract` from here with `import type`, which
// erases entirely, so the sandboxed preload — which bundles `ipc.ts` — still pulls no zod.
// Main is the only side that imports the table for its value.

/** The directions that carry nothing: a menu-driven command's request, a write's answer. One
 * shared instance because a zod schema is immutable and fifteen `z.void()`s said nothing extra. */
const NoPayload = z.void();

/** `satisfies Record<IpcChannelName, …>` is what keeps this table and `IpcChannel` in step:
 * a channel added to one and not the other fails to compile — missing key here, excess key
 * there. The value type is deliberately loose (`z.ZodType`); it is `IpcContract` that pins each
 * entry's meaning, by deriving from it. */
export const IPC_SCHEMAS = {
  "theme:get": { request: NoPayload, response: ThemeId },
  "theme:set": { request: ThemeId, response: NoPayload },
  "cli:status": { request: NoPayload, response: CliStatus },
  // Answers with the state *after* the attempt rather than a bare success flag: the guide
  // shows where the launcher landed, and "installed" is a fact on disk either way.
  "cli:install": { request: NoPayload, response: CliInstallResult },
  "onboarding:get": { request: NoPayload, response: z.boolean() },
  "onboarding:complete": { request: NoPayload, response: NoPayload },
  "repo:open": { request: NoPayload, response: OpenRepoResponse },
  // Dialog: main owns the picker, so the request is void. Path: the renderer
  // supplies the dropped path, guarded in main before use.
  "review:open": { request: NoPayload, response: ReviewOpenResponse },
  "review:open-path": { request: ReviewOpenPathRequest, response: ReviewOpenResponse },
  // Answers plainly rather than in a result envelope: "the directory would not open" is a
  // field on the answer (see RecentReviewsResponse), not a failed call.
  "reviews:recent": { request: NoPayload, response: RecentReviewsResponse },
  "review:save-json": { request: ReviewSaveRequest, response: ReviewSaveResponse },
  "review:save-markdown": { request: ReviewSaveRequest, response: ReviewSaveResponse },
  "git:branches": { request: RepoRequest, response: BranchesResponse },
  "git:log": { request: LogRequest, response: LogResponse },
  "git:diff": { request: DiffRequest, response: DiffResponse },
  "git:file-contents": { request: FileContentsRequest, response: FileContentsResponse },
  // Session channels answer plainly, not in the GitResult envelope: no git runs
  // here and the store's salvage-on-load semantics mean reads always succeed.
  "sessions:list": { request: NoPayload, response: SessionSnapshot },
  "sessions:create": { request: SessionCreateRequest, response: Session },
  "sessions:update": { request: Session, response: NoPayload },
  "sessions:delete": { request: SessionIdRequest, response: NoPayload },
  "sessions:set-active": { request: SessionIdRequest, response: NoPayload },
  "sessions:reorder": { request: SessionOrderRequest, response: NoPayload },
} as const satisfies Record<IpcChannelName, { request: z.ZodType; response: z.ZodType }>;

/** Single source of truth linking each channel to its wire types; main handlers and the
 * preload bridge are both typechecked against it. Derived, never written: each entry is
 * `z.infer` of the schema the boundary parses with, so the two cannot drift. */
export type IpcContract = {
  [Channel in keyof typeof IPC_SCHEMAS]: {
    request: z.infer<(typeof IPC_SCHEMAS)[Channel]["request"]>;
    response: z.infer<(typeof IPC_SCHEMAS)[Channel]["response"]>;
  };
};
