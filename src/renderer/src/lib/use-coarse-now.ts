import { useEffect, useState } from "react";

/** A coarse ticking clock: surfaces that stay mounted for whole sessions (the
 * commit list, comment timestamps) must not freeze their relative ages at mount
 * time. One 60s tick is enough resolution for "2h ago" / "3d ago". */
export function useCoarseNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}
