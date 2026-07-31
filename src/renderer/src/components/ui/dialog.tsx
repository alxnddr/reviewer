import * as React from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { XIcon } from "lucide-react";

// Two surfaces, one shell. `default` is the opaque slab, centred: the right answer for
// anything that asks a question and is then dismissed. `glass` is the lens — a panel held
// up over the reader's work to check something (the shortcut sheet, the recents picker),
// where the diff staying visible behind it is the whole point. They differ only in surface
// and placement, which is a variant rather than a second component; what `data-glass`
// actually paints lives in `index.css`.

const dialogOverlayVariants = cva(
  "fixed inset-0 z-50 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
  {
    variants: {
      variant: {
        default: "isolate bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs",
        // Dimmer than the slab's, and blurred a little harder: a glass popup is itself
        // translucent, and over an un-dimmed diff the two layers of code — the real one
        // behind and the rows in front — compete at the same contrast.
        glass: "bg-black/15 duration-150 supports-backdrop-filter:backdrop-blur-sm",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

const dialogContentVariants = cva(
  "fixed left-1/2 z-50 -translate-x-1/2 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
  {
    variants: {
      variant: {
        default:
          "top-1/2 grid w-full max-w-[calc(100%-2rem)] -translate-y-1/2 gap-4 rounded-xl bg-popover p-4 text-sm text-popover-foreground ring-1 ring-foreground/10 duration-100 sm:max-w-sm",
        // No fill and no ring — `[data-glass]` paints both. Held above centre rather than
        // in it, so the caller supplies `top-*` and its own width; everything else about
        // the two glass panels is the same panel.
        glass: "flex max-h-[72vh] flex-col overflow-hidden rounded-2xl duration-150",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({
  className,
  variant = "default",
  ...props
}: DialogPrimitive.Backdrop.Props & VariantProps<typeof dialogOverlayVariants>) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={cn(dialogOverlayVariants({ variant }), className)}
      {...props}
    />
  );
}

function DialogContent({
  className,
  children,
  variant = "default",
  showCloseButton = true,
  ...props
}: DialogPrimitive.Popup.Props &
  VariantProps<typeof dialogContentVariants> & {
    showCloseButton?: boolean;
  }) {
  return (
    <DialogPortal>
      <DialogOverlay variant={variant} />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        // The glass surface is a stylesheet rule keyed off the attribute rather than a
        // class, so the variant hands it out along with the classes.
        data-glass={variant === "glass" ? "" : undefined}
        className={cn(dialogContentVariants({ variant }), className)}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            render={<Button variant="ghost" className="absolute top-2 right-2" size="icon-sm" />}
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="dialog-header" className={cn("flex flex-col gap-2", className)} {...props} />
  );
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean;
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "-mx-4 -mb-4 flex flex-col-reverse gap-2 rounded-b-xl border-t bg-muted/50 p-4 sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close render={<Button variant="outline" />}>Close</DialogPrimitive.Close>
      )}
    </div>
  );
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-base leading-none font-medium", className)}
      {...props}
    />
  );
}

function DialogDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        "text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
