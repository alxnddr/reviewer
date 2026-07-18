import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// Teach tailwind-merge our app-defined font-size step (`text-title`, index.css
// `@theme`): without this it treats the class as unknown and leaves whatever
// built-in `text-*` size a component's base already set (e.g. the button's
// `text-sm`), so the intended size would win only by generated-CSS order.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": ["text-title"],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
