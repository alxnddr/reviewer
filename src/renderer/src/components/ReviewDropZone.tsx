import {
  useCallback,
  useRef,
  useState,
  type DragEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { claimFileDrag, isFileDrag, takeDroppedFile } from "@/lib/review-drop";
import { useReviewStore } from "@/stores/review";

type ReviewDropZoneProps = {
  children: ReactNode;
};

/** Window-wide drop target for `.reviewer.json`. The drop policy — always
 * preventDefault a file drag, resolve the path in the preload, invoke the guard —
 * lives in `lib/review-drop`; this component owns only the overlay affordance. A
 * drag depth counter keeps the overlay steady as the pointer crosses child
 * elements (each fires its own enter/leave). */
export function ReviewDropZone({ children }: ReviewDropZoneProps): ReactElement {
  const openDroppedFile = useReviewStore((state) => state.openDroppedFile);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const dragDepth = useRef(0);

  const handleDragEnter = useCallback((event: DragEvent): void => {
    if (!claimFileDrag(event)) {
      return;
    }
    dragDepth.current += 1;
    setIsDraggingFile(true);
  }, []);

  const handleDragOver = useCallback((event: DragEvent): void => {
    if (!claimFileDrag(event)) {
      return;
    }
    event.dataTransfer.dropEffect = "copy";
  }, []);

  const handleDragLeave = useCallback((event: DragEvent): void => {
    if (!isFileDrag(event.dataTransfer)) {
      return;
    }
    dragDepth.current -= 1;
    if (dragDepth.current <= 0) {
      dragDepth.current = 0;
      setIsDraggingFile(false);
    }
  }, []);

  const handleDrop = useCallback(
    (event: DragEvent): void => {
      dragDepth.current = 0;
      setIsDraggingFile(false);
      const file = takeDroppedFile(event);
      if (file !== null) {
        void openDroppedFile(file);
      }
    },
    [openDroppedFile],
  );

  return (
    <div
      className="relative h-dvh"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {children}
      {isDraggingFile && (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-background/75">
          <div className="rounded-xl border-2 border-dashed border-accent-strong bg-surface px-6 py-4 text-sm text-foreground shadow-lg">
            Drop a <span className="font-mono">.reviewer.json</span> to open the review
          </div>
        </div>
      )}
    </div>
  );
}
