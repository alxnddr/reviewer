import type { GitRunner } from "./git/runner";
import type { SessionStore } from "./sessions";

/** The will-quit sequence in its load-bearing order: the pending session write
 * lands on disk first, then git children die. Reversed, the process could exit
 * right after termination and lose the last debounced mutation. */
export function flushSessionsThenTerminateGit(
  sessions: Pick<SessionStore, "flush">,
  git: Pick<GitRunner, "terminateAll">,
): void {
  sessions.flush();
  git.terminateAll();
}
