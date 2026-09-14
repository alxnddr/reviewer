import "./index.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initInputModality } from "./lib/input-modality";
import { useReviewStore } from "./stores/review";
import { useSettingsStore } from "./stores/settings";

// Settings — the theme class above all — before first render: with show:false + ready-to-show
// in main, the window becomes visible only after this has applied, so cold start cannot flash.
// The OS seed lands synchronously; the stored record follows when main answers.
void useSettingsStore.getState().init();

// Document-level listeners with no React state behind them, so they mount once here
// rather than riding a component's effect.
initInputModality();

// The renderer owns the write-back debounce, so the renderer must flush
// it: a mutation still in the timer window is sent before the window goes away,
// ahead of main's own will-quit disk flush. Both events fire on quit; the flush
// empties its queue, so the second call is a no-op.
const flushWriteBacks = (): void => useReviewStore.getState().flushWriteBacks();
window.addEventListener("beforeunload", flushWriteBacks);
window.addEventListener("pagehide", flushWriteBacks);

if (import.meta.env.DEV) {
  // Browser-gate affordance: seed a fixture state from ?state= before first paint.
  const { applyPreviewState } = await import("./dev/preview");
  applyPreviewState();
}

const root = document.getElementById("root");
if (!root) {
  throw new Error("index.html must contain a #root element");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
