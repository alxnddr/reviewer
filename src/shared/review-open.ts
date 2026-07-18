import * as z from "zod";
import { SessionId } from "./session";

// The open-a-review IPC contract: the three entry points (dialog,
// drop, CLI/`open-file`) all cross one main-side guard, and a file path — from a
// renderer drop or from argv — is untrusted until main has validated it. Every
// bad input lands in one of these typed failures rather than a throw across IPC.
// Kept apart from `review.ts` so the outcome can name a `SessionId` without
// `review.ts` importing `session.ts` (which imports `review.ts` in turn).

/** Why a path could not become an open review. Ordered as the guard checks them:
 * extension → existence/kind → size → readability → content. Each is a distinct
 * visible state, never a crash. */
export const ReviewOpenFailure = z.discriminatedUnion("code", [
  z.object({ code: z.literal("wrongExtension") }),
  z.object({ code: z.literal("fileNotFound") }),
  z.object({ code: z.literal("tooLarge") }),
  z.object({ code: z.literal("unreadable") }),
  z.object({ code: z.literal("invalidContent") }),
]);
export type ReviewOpenFailure = z.infer<typeof ReviewOpenFailure>;

/** The success shape a dialog/drop invoke answers with: an opened review names
 * the session main created for it; `canceled` is the dialog's dismiss (drop and
 * CLI never cancel — they either open or fail). */
export const ReviewOpenOutcome = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("opened"), sessionId: SessionId }),
  z.object({ kind: z.literal("canceled") }),
]);
export type ReviewOpenOutcome = z.infer<typeof ReviewOpenOutcome>;

/** Response envelope for the dialog/drop channels: like `GitResultOf`, the
 * renderer always receives a discriminated result, never a rejected promise. */
export const ReviewOpenResponse = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: ReviewOpenOutcome }),
  z.object({ ok: z.literal(false), failure: ReviewOpenFailure }),
]);
export type ReviewOpenResponse = z.infer<typeof ReviewOpenResponse>;

/** The drop path's request: the renderer resolves a dropped File to its disk
 * path (preload `webUtils`) and hands it here. Untrusted — the main guard
 * normalizes and re-checks it before a single byte is read. */
export const ReviewOpenPathRequest = z.object({ path: z.string().min(1) });
export type ReviewOpenPathRequest = z.infer<typeof ReviewOpenPathRequest>;
