// The two questions every caught `unknown` in this app ends up asking: what does it say, and
// which errno is it. Both were answered by a copy per program — `errorMessage` twice (the CLI
// and the artifact validator), the errno sniff five times (the CLI, the review guard, the
// recents lister, git ops, the git runner), each narrowing its way to `.code` slightly
// differently: two cast past the type, one `in` check, one that skipped `instanceof Error`
// entirely.
//
// Node-free by construction (tsconfig.shared.json): `NodeJS.ErrnoException` is not nameable
// from this half of `shared/`, and does not need to be — an errno is a string property hanging
// off an `Error` at runtime, which is exactly what is checked here.

/** The message of a caught `unknown`, without letting a non-Error throw stringify to
 * `[object Object]`. Every shell effect that reports a failure as prose (reading an artifact,
 * spawning git, writing an output file) goes through this, so a caller reads one message
 * shape whichever code path produced it. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The errno a caught `unknown` carries — `"ENOENT"`, `"EISDIR"`, `"EACCES"` — or undefined
 * when it carries none. Callers compare against the code they mean
 * (`errnoCode(error) === "ENOENT"`) rather than each keeping a boolean helper per code.
 *
 * A non-string `code` reads as no errno: the property is untyped at runtime, and a truthy
 * non-string would otherwise compare unequal to every code and silently mean "some other
 * failure" anyway. */
export function errnoCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}
