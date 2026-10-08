import { useMemo } from "react";
import type { ReviewLayer } from "../../../shared/review";
import type { PatchFile } from "../../../shared/diff/patch";
import type { ReferenceSpan } from "../../../shared/markdown";
import { outlineDiff } from "../../../shared/diff/outline";
import { layerOutline } from "../../../shared/layers";
import { isMachineWritten } from "./initial-folds";
import {
  chapterSymbols,
  createBadgeLookup,
  guideSymbols,
  type AnchorDoor,
  type ChapterBadge,
  type GuideSymbol,
} from "./guide";
import type { AnchorSpan } from "../../../shared/review";

/** What the chapter band shows beside its prose: the badge lookup for its picture, the symbols
 * its extent changed, and the door both open through — bounded by the soloed file set, so an
 * element pointing outside the chapter is inert, as a prose chip there is.
 *
 * The outline is computed only while a chapter is soloed (the band is the only reader on this
 * screen), over the *whole* loaded diff — a chapter's symbols are the outline's symbols that the
 * chapter owns, the same answer the guide's rows give. React glue over pure functions
 * (`lib/guide.ts`, `shared/diff/outline.ts`), which are where the tests are. */
export function useChapterEvidence(
  layers: readonly ReviewLayer[],
  files: readonly PatchFile[] | null,
  activeLayerId: string | null,
  visiblePaths: readonly string[],
  onSelectReference: (path: string, span: ReferenceSpan | null) => void,
): {
  badgeOf: (anchor: AnchorSpan | undefined) => ChapterBadge | null;
  symbols: GuideSymbol[];
  door: AnchorDoor;
} {
  const badgeOf = useMemo(() => createBadgeLookup(layers), [layers]);
  const soloed = activeLayerId !== null;
  const all = useMemo(
    () =>
      soloed && files !== null
        ? guideSymbols(outlineDiff(files, { skip: isMachineWritten }), badgeOf)
        : [],
    [soloed, files, badgeOf],
  );
  const symbols = useMemo(() => {
    const entry = layerOutline(layers).find((candidate) => candidate.layer.id === activeLayerId);
    return entry === undefined
      ? []
      : chapterSymbols(all, new Set(entry.subtree.map((layer) => layer.id)));
  }, [all, layers, activeLayerId]);
  const door = useMemo<AnchorDoor>(
    () => ({
      paths: new Set(visiblePaths),
      open: (anchor) =>
        onSelectReference(anchor.file, {
          side: anchor.side,
          startLine: anchor.startLine,
          endLine: anchor.endLine,
        }),
    }),
    [visiblePaths, onSelectReference],
  );
  return { badgeOf, symbols, door };
}
