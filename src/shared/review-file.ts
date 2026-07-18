// The on-disk identity of a review artifact: the one extension every `.reviewer.json`
// carries. Both open paths gate on it — main's import guard (a dropped/picked/argv path is
// rejected before a byte is read) and the CLI's `rvw open` (a launch is refused before the
// app is asked to open a non-review) — so the string lives here once and cannot drift
// between the two sides. A leaf module with no dependencies, safe to import from `src/main`
// and from the bundled CLI alike.
export const REVIEW_EXTENSION = ".reviewer.json";
