import type { BootSlice } from "./boot";
import type { CurationSlice } from "./curation";
import type { ExportSlice } from "./export";
import type { OpenSlice } from "./open";
import type { PickerSlice } from "./picker";
import type { ProgressSlice } from "./progress";
import type { TabsSlice } from "./tabs";
import type { WalkthroughSlice } from "./walkthrough";
import type { WriteBackSlice } from "./write-back";

/** The whole store, as the intersection of the nine slices that make it up. Each of them is
 * declared beside the actions that maintain it, so a field's prose sits with its code; this is
 * the one place that says what the set of them adds up to.
 *
 * It lives in its own module rather than in `../review.ts` so that the slices can name the
 * state they read across (`Getter`, `StateCreator`'s first parameter) without importing the
 * file that composes them — every arrow in this directory points *down*, at the shared shape,
 * never back at the store. */
export type ReviewState = BootSlice &
  TabsSlice &
  OpenSlice &
  PickerSlice &
  ProgressSlice &
  CurationSlice &
  WalkthroughSlice &
  ExportSlice &
  WriteBackSlice;
