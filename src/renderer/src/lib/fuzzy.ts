// Fuzzy path filtering for the changed-file tree. @pierre/trees' built-in search
// is substring-only, so the tree is filtered outside the model with this matcher.

/** Case-insensitive subsequence match: every query character must appear in
 * `text` in the same order, with gaps allowed — "srcbtn" matches
 * "src/components/Button.tsx". Whitespace in the query is ignored so fragments
 * can be typed apart; a blank query matches everything. */
export function fuzzyMatches(query: string, text: string): boolean {
  const needle = query.replace(/\s/g, "").toLowerCase();
  if (needle.length === 0) {
    return true;
  }
  const haystack = text.toLowerCase();
  let searchFrom = 0;
  for (const char of needle) {
    const foundAt = haystack.indexOf(char, searchFrom);
    if (foundAt === -1) {
      return false;
    }
    searchFrom = foundAt + 1;
  }
  return true;
}
