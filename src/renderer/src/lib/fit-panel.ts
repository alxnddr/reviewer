import { useCallback, useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import {
  useGroupRef,
  usePanelRef,
  type GroupImperativeHandle,
  type Layout,
  type LayoutChangedMeta,
  type PanelImperativeHandle,
} from "react-resizable-panels";

// Two surfaces size a resize panel to the content it holds rather than to a share of
// the pane: the sidebar's layers list and the diff's layer intro. Both open fitted to
// their own rows/prose — capped so a long one never swallows the pane — and stay
// draggable from there until the content they size to changes. react-resizable-panels
// has no content-based size (px/%/em/rem/vh/vw only), so the fit is measured and
// applied through the imperative API; this is the one place that does it.

function px(value: string): number {
  // oxlint-disable-next-line unicorn/prefer-number-coercion -- the input is a computed style ("40px"); `Number()` would give NaN where `parseFloat` gives 40
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** The height the panel needs for `content` to show in full.
 *
 * A fitted panel is a flex column: fixed chrome above one flexible scroll viewport.
 * So its natural height is everything between the panel's top edge and the viewport's
 * (headings, borders), plus the viewport's own frame and padding, plus the content's
 * height — measured on the block that scrolls, since the viewport around it is
 * stretched to whatever the panel currently is. Every inset is read back from the DOM,
 * so restyling the chrome needs no counterpart here. */
function naturalHeight(panel: HTMLElement, viewport: HTMLElement, content: HTMLElement): number {
  // Rect tops rather than offsetTop: unaffected by how far the viewport happens to be
  // scrolled, and by which ancestor happens to be the positioned one.
  const chrome = viewport.getBoundingClientRect().top - panel.getBoundingClientRect().top;
  // Borders — and a horizontal scrollbar, when one shows — sit outside clientHeight.
  const frame = viewport.offsetHeight - viewport.clientHeight;
  const style = getComputedStyle(viewport);
  const padding = px(style.paddingTop) + px(style.paddingBottom);
  // Round up: a fractional shortfall would leave the viewport scrollable by a hair.
  return Math.ceil(chrome + frame + padding + content.offsetHeight);
}

/** The refs the fitted panel's content component attaches so the fit can measure what
 * it is sizing to: the scroll viewport (the panel's one flexible child) and the block
 * that scrolls inside it, which keeps its natural height however tall that viewport is
 * stretched. */
export type FitToContentRefs = {
  viewportRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
};

export type FitToContent = {
  /** Spread onto the `ResizablePanelGroup`. */
  group: {
    elementRef: RefObject<HTMLDivElement | null>;
    groupRef: RefObject<GroupImperativeHandle | null>;
    onLayoutChanged: (layout: Layout, meta: LayoutChangedMeta) => void;
  };
  /** Spread onto the `ResizablePanel` that hugs its content. */
  panel: {
    elementRef: RefObject<HTMLDivElement | null>;
    panelRef: RefObject<PanelImperativeHandle | null>;
  };
  /** Handed to the component rendered inside that panel. */
  content: FitToContentRefs;
};

type FitToContentOptions = {
  /** Whether the fitted panel is on screen; switching it on requests a fresh fit. */
  enabled: boolean;
  /** Requests a fresh fit whenever this changes identity — the content being sized to
   * is a different one now (another layer, a reloaded layer set). */
  refitOn?: unknown;
  /** Ceiling on the fit as a share of the group, so long content caps instead of
   * crowding out the panel below it. The seam can still be dragged past it. */
  maxShare?: number;
};

/** Opens a vertical group's first panel at the height its content needs. */
export function useFitToContent({
  enabled,
  refitOn,
  maxShare = 0.5,
}: FitToContentOptions): FitToContent {
  const groupElRef = useRef<HTMLDivElement>(null);
  const panelElRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const groupRef = useGroupRef();
  const panelRef = usePanelRef();
  // A requested fit that could not be applied yet. A group defers its initial layout
  // until it has measured itself — until then it reports no layout and resize() cannot
  // apply — so the request waits for the layout event that follows.
  const pendingRef = useRef(false);

  const fit = useCallback(() => {
    const groupEl = groupElRef.current;
    const panelEl = panelElRef.current;
    const viewport = viewportRef.current;
    const content = contentRef.current;
    const group = groupRef.current;
    const panel = panelRef.current;
    if (
      groupEl === null ||
      panelEl === null ||
      viewport === null ||
      content === null ||
      group === null ||
      panel === null
    ) {
      return;
    }
    // Still deferred: leave the request pending for onLayoutChanged.
    if (Object.keys(group.getLayout()).length === 0) {
      return;
    }
    const natural = naturalHeight(panelEl, viewport, content);
    panel.resize(Math.min(natural, groupEl.clientHeight * maxShare));
    pendingRef.current = false;
  }, [groupRef, panelRef, maxShare]);

  // Neither appearing nor a content swap moves the seam, so the library fires no
  // layout event for them: this attempt is what fits them.
  useLayoutEffect(() => {
    if (!enabled) {
      return;
    }
    pendingRef.current = true;
    fit();
  }, [enabled, refitOn, fit]);

  const onLayoutChanged = useCallback(
    (_layout: Layout, meta: LayoutChangedMeta) => {
      if (meta.isUserInteraction) {
        // The reviewer has taken the seam over; a pending fit stands down rather than
        // snapping it back from under them.
        pendingRef.current = false;
      } else if (pendingRef.current) {
        fit();
      }
    },
    [fit],
  );

  return useMemo(
    () => ({
      group: { elementRef: groupElRef, groupRef, onLayoutChanged },
      panel: { elementRef: panelElRef, panelRef },
      content: { viewportRef, contentRef },
    }),
    [groupRef, panelRef, onLayoutChanged],
  );
}
