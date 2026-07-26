type Step = { unit: Intl.RelativeTimeFormatUnit; seconds: number };

const STEPS: Step[] = [
  { unit: "year", seconds: 365 * 24 * 3600 },
  { unit: "month", seconds: 30 * 24 * 3600 },
  { unit: "day", seconds: 24 * 3600 },
  { unit: "hour", seconds: 3600 },
  { unit: "minute", seconds: 60 },
];

/** A commit's age as a column: "7h", "3d", "2mo". No "ago" — in a right-aligned column
 * beside a list of commits there is nothing else it could mean, and the four characters
 * it saves are four characters of subject, which is the thing being read.
 *
 * `now` is a parameter, not a read, so the formatting is a pure, testable function. */
export function shortAge(iso: string, now: Date): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) {
    return "";
  }
  const elapsedSeconds = Math.max(0, Math.floor((now.getTime() - then) / 1000));
  for (const step of STEPS) {
    if (elapsedSeconds >= step.seconds) {
      return `${Math.floor(elapsedSeconds / step.seconds)}${SHORT_UNITS[step.unit] ?? ""}`;
    }
  }
  return "now";
}

const SHORT_UNITS: Partial<Record<Intl.RelativeTimeFormatUnit, string>> = {
  year: "y",
  month: "mo",
  day: "d",
  hour: "h",
  minute: "m",
};

const ABSOLUTE = new Intl.DateTimeFormat("en", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/** The date behind the age, for the hover hint on a commit row. "3d ago" is the right
 * thing to *scan* a list by and the wrong thing to answer "which day was that" with,
 * so the row keeps the age and the hint carries the timestamp — one fact each, neither
 * repeating the other. */
export function absoluteTime(iso: string): string {
  const then = new Date(iso);
  return Number.isNaN(then.getTime()) ? "" : ABSOLUTE.format(then);
}
