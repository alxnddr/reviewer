"use client";

import {
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";

import { cn } from "@/lib/utils";

/** The one hover delay the whole app uses. Long enough that crossing a dense list
 * (a tab strip, a file group, a commit list) doesn't trail popups behind the
 * pointer, short enough to read as an answer to hovering rather than an accident.
 * This is what makes the kit's tooltip usable where a native `title` was before:
 * the browser's own delay is neither tunable nor consistent. */
const TOOLTIP_DELAY_MS = 700;

function TooltipProvider({ delay = 0, ...props }: TooltipPrimitive.Provider.Props) {
  return <TooltipPrimitive.Provider data-slot="tooltip-provider" delay={delay} {...props} />;
}

function Tooltip({ ...props }: TooltipPrimitive.Root.Props) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

function TooltipTrigger({ ...props }: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

function TooltipContent({
  className,
  side = "top",
  sideOffset = 4,
  align = "center",
  alignOffset = 0,
  anchor,
  children,
  ...props
}: TooltipPrimitive.Popup.Props &
  Pick<
    TooltipPrimitive.Positioner.Props,
    "align" | "alignOffset" | "anchor" | "side" | "sideOffset"
  >) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        // Defaults to the trigger; pass an anchor when the trigger is stretched
        // for hit-target reasons and the popup should track its content instead.
        anchor={anchor}
        side={side}
        sideOffset={sideOffset}
        className="isolate z-50"
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          className={cn(
            "z-50 inline-flex w-fit max-w-xs origin-(--transform-origin) items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-xs text-background has-data-[slot=kbd]:pr-1.5 data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 **:data-[slot=kbd]:relative **:data-[slot=kbd]:isolate **:data-[slot=kbd]:z-50 **:data-[slot=kbd]:rounded-sm data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className,
          )}
          {...props}
        >
          {children}
          <TooltipPrimitive.Arrow className="z-50 size-2.5 translate-y-[calc(-50%-2px)] rotate-45 rounded-[2px] bg-foreground fill-foreground data-[side=bottom]:top-1 data-[side=inline-end]:top-1/2! data-[side=inline-end]:-left-1 data-[side=inline-end]:-translate-y-1/2 data-[side=inline-start]:top-1/2! data-[side=inline-start]:-right-1 data-[side=inline-start]:-translate-y-1/2 data-[side=left]:top-1/2! data-[side=left]:-right-1 data-[side=left]:-translate-y-1/2 data-[side=right]:top-1/2! data-[side=right]:-left-1 data-[side=right]:-translate-y-1/2 data-[side=top]:-bottom-2.5" />
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}

/** True while the element's content is wider than the box holding it — i.e. while
 * `truncate` is actually eliding something. Re-measures on every resize, which is
 * what a dragged sidebar seam or a resized window produces. Only runs while the
 * caller needs the answer; an always-on hint never pays for an observer. */
function useOverflowing(
  ref: RefObject<HTMLElement | null>,
  enabled: boolean,
  contentKey: string | null,
): boolean {
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const element = ref.current;
    if (element === null) {
      return;
    }
    const measure = (): void => {
      setOverflowing(element.scrollWidth > element.clientWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, enabled, contentKey]);

  return overflowing;
}

type TooltipHintProps = {
  /** What the popup says. Nothing is rendered — not even a trigger — when this is
   * empty, so a row with no overflow text to recover stays inert. */
  content: ReactNode;
  /** The element the hint hangs off: it becomes the trigger itself (Base UI merges
   * the trigger's handlers onto it), so no extra wrapper enters the layout. */
  children: ReactElement<Record<string, unknown>>;
  /** For hints that only recover clipped text: the popup opens only while the
   * trigger is actually eliding something. A tooltip that repeats text already
   * fully on screen is noise, so every truncate-recovery site sets this — leave it
   * off only when the popup says something the row does not. */
  whenTruncated?: boolean;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  /** Anchor the popup to something other than the trigger — a stretched hit target
   * whose popup should track a narrower element, or vice versa. */
  anchor?: RefObject<HTMLElement | null>;
  /** Suppress the popup without changing the tree (mid-drag, mid-edit). */
  disabled?: boolean;
  className?: string;
};

/** The replacement for a native `title`: the kit's tooltip on the app's shared
 * delay, wrapping whatever element carried the attribute. The delay rides on the
 * trigger rather than a Provider — a provider shared across a list has its
 * triggers contend for one active slot, and one per hint is a wrapper per row for
 * nothing. */
function TooltipHint({
  content,
  children,
  whenTruncated = false,
  side = "top",
  align = "center",
  anchor,
  disabled = false,
  className,
}: TooltipHintProps): ReactElement {
  // Typed as the button Base UI's trigger nominally renders, whatever element the
  // caller actually supplies — measuring only needs an HTMLElement.
  const triggerRef = useRef<HTMLButtonElement>(null);
  const empty = disabled || content === null || content === undefined || content === "";
  const truncated = useOverflowing(
    triggerRef,
    whenTruncated && !empty,
    typeof content === "string" ? content : null,
  );

  if (empty) {
    return children;
  }
  return (
    <Tooltip>
      {/* The trigger stays mounted (and measured) even while muted, so the popup
          arms itself the moment the text starts clipping — a narrowed rail must not
          need a re-mount to become recoverable. */}
      <TooltipTrigger
        ref={triggerRef}
        delay={TOOLTIP_DELAY_MS}
        disabled={whenTruncated && !truncated}
        render={children}
      />
      <TooltipContent side={side} align={align} anchor={anchor} className={className}>
        {content}
      </TooltipContent>
    </Tooltip>
  );
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider, TooltipHint, TOOLTIP_DELAY_MS };
