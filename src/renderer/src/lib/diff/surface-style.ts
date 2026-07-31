import type { CodeViewLayout } from "@pierre/diffs";

// What the diff surface is asked to look like, as opposed to what it shows: the two
// constants below are the whole of this app's styling of Pierre's own rendering, and
// each is one narrow correction to a package default. Everything else about the
// surface — themes, gutters, bands — is Pierre's, inside its shadow root.

// Two overrides injected through Pierre's `unsafeCSS` hatch — its own `@layer unsafe`, which outranks
// the theme's `@layer rendered`, so both win inside the shadow root without touching Pierre's themes:
//   1. The header stat counts (+n/−n) are hard-wired to the CODE font in the package stylesheet; they
//      are header chrome and must follow the header sans. No public var covers them.
//   2. The diff surface background is bridged to our `--diff-surface` token (it inherits through the
//      shadow boundary). Pierre derives `--diffs-bg` — and with it the code, header, separator, and
//      gutter backgrounds — from these `--diffs-*-bg` source vars, so the whole surface follows the
//      token while the per-span `--diffs-token-*` syntax colours stay Pierre's. Each theme's
//      `--diff-surface` already equals its Pierre editor bg, so this only moves pierre-dark, whose
//      surface is deliberately the neutral shell colour rather than Pierre's near-black — the diff
//      pane then matches the layer band and the shell instead of reading blacker than them.
export const DIFF_UNSAFE_CSS = `
  [data-diffs-header="default"] [data-additions-count],
  [data-diffs-header="default"] [data-deletions-count] {
    font-family: var(--diffs-header-font-family, var(--diffs-header-font-fallback));
  }
  :host {
    --diffs-light-bg: var(--diff-surface);
    --diffs-dark-bg: var(--diff-surface);
    /* Content, not chrome: the diff code and its inline comment threads read back as
     * selectable text (the shell's body sets user-select:none, which otherwise
     * inherits through the shadow boundary and freezes the whole surface). */
    user-select: text;
    -webkit-user-select: text;
  }
`;

// Pierre lays its top padding out as a margin above the virtualized container, so
// the first file's sticky header carries an 8px gap that only shows when scrolled
// fully to the top — once the header sticks to top:0 it hides the margin, which
// reads as the topmost band having a taller top than its stuck twin. Zero the top
// so the first band's height is honest at rest; the inter-file gap and tail
// padding stay at Pierre's default 8px.
export const DIFF_LAYOUT: CodeViewLayout = { paddingTop: 0, paddingBottom: 8, gap: 8 };
