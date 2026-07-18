// A review endpoint (ReviewRef) is a branch name or a full 40/64-hex sha. In the
// rail chrome a full sha would overflow, so it reads as a short sha; a branch name
// stays verbatim. Shared so the sidebar label and the review selector abbreviate
// endpoints the same way.

const HEX_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** A `ReviewRef` abbreviated for chrome: a sha collapses to 7 chars, a branch name
 * is left as authored. */
export function shortRef(ref: string): string {
  return HEX_SHA.test(ref) ? shortSha(ref) : ref;
}
