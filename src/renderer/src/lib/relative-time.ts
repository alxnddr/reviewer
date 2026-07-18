const FORMATTER = new Intl.RelativeTimeFormat("en", { numeric: "always", style: "narrow" });

type Step = { unit: Intl.RelativeTimeFormatUnit; seconds: number };

const STEPS: Step[] = [
  { unit: "year", seconds: 365 * 24 * 3600 },
  { unit: "month", seconds: 30 * 24 * 3600 },
  { unit: "day", seconds: 24 * 3600 },
  { unit: "hour", seconds: 3600 },
  { unit: "minute", seconds: 60 },
];

/** Dense commit-row age ("2h ago", "3d ago"). `now` is a parameter, not a read,
 * so the formatting is a pure, testable function. */
export function relativeTime(iso: string, now: Date): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) {
    return "";
  }
  const elapsedSeconds = Math.max(0, Math.floor((now.getTime() - then) / 1000));
  for (const step of STEPS) {
    if (elapsedSeconds >= step.seconds) {
      return FORMATTER.format(-Math.floor(elapsedSeconds / step.seconds), step.unit);
    }
  }
  return "just now";
}
