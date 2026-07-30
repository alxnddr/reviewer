import { useEffect, useState, type ReactElement } from "react";
import { createFileTreeIconResolver, getBuiltInSpriteSheet } from "@pierre/trees";
import { cn } from "@/lib/utils";

// The file-type glyph the sidebar tree already draws, available to the rest of the app.
// Pierre's tree resolves a path to a sprite symbol and renders `<use href="#symbol">`
// inside its shadow root; the same resolver is exported, so any list of paths can show
// the *same* icon for a path the tree shows — one visual vocabulary for "this file",
// wherever a file is named.
//
// The sprite sheet the symbols live in has to be in this document (the tree keeps its own
// copy in its shadow root), so it is injected once, hidden, on first use.

/** The tree's default set — `FileTreePanel` passes no `icons`, and this must resolve to
 * the same glyphs, so both take the library default rather than picking a set here. */
const ICON_SET = "complete";
const SPRITE_DOM_ID = "pierre-file-icon-sprite";

const { resolveIcon } = createFileTreeIconResolver();

/** Injects the sprite once per document. Idempotent by id, so every icon can call it and
 * only the first does work. Returns whether the symbols are available to reference. */
function ensureSprite(): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  if (document.getElementById(SPRITE_DOM_ID) !== null) {
    return true;
  }
  const host = document.createElement("div");
  host.id = SPRITE_DOM_ID;
  host.setAttribute("aria-hidden", "true");
  host.style.display = "none";
  // A build-time asset from the library, not content — never a user or artifact string.
  host.innerHTML = getBuiltInSpriteSheet(ICON_SET);
  document.body.append(host);
  return true;
}

type FileTypeIconProps = {
  path: string;
  className?: string;
};

/** The icon for `path`'s type — coloured, like the tree's. Decorative: the path is always
 * beside it, so it carries no label of its own. */
export function FileTypeIcon({ path, className }: FileTypeIconProps): ReactElement | null {
  // The symbols must exist before a `<use>` can reference them. The injection runs on the
  // first render rather than in an effect: these sit inline in prose, and an icon that
  // arrives a frame late reflows the sentence around it. It is idempotent and touches only
  // its own hidden node, so running it twice (StrictMode) costs nothing.
  const [ready, setReady] = useState(ensureSprite);
  useEffect(() => {
    if (!ready) {
      setReady(ensureSprite());
    }
  }, [ready]);

  const icon = resolveIcon("file-tree-icon-file", path);
  if (!ready) {
    return null;
  }
  return (
    // The symbols paint in `currentColor`; `data-file-icon` carries the resolved type so
    // index.css can colour it exactly as the tree's stylesheet colours its own (that
    // stylesheet is `:host`-scoped and unreachable from here — see the note there).
    <svg
      aria-hidden="true"
      data-file-icon={icon.token ?? "default"}
      viewBox={icon.viewBox ?? "0 0 16 16"}
      className={cn("size-4 shrink-0", className)}
    >
      <use href={`#${icon.name.replace(/^#/u, "")}`} />
    </svg>
  );
}
