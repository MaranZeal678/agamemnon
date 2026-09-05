import { useEffect, useRef, useState } from "react";

// Poll a JSON endpoint on an interval. Every value the dashboard shows comes
// from here — genuine live queries against the real Postgres.
export function usePoll<T>(url: string, intervalMs: number): T | null {
  const [data, setData] = useState<T | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const res = await fetch(url);
        if (res.ok && alive.current) setData(await res.json());
      } catch {
        /* transient; keep last value */
      }
      if (alive.current) timer = setTimeout(tick, intervalMs);
    };
    tick();
    return () => {
      alive.current = false;
      clearTimeout(timer);
    };
  }, [url, intervalMs]);
  return data;
}

// Smoothly tween a displayed integer toward a target so a stepped poll reads as
// a continuous drain on screen.
export function useTween(target: number | null, ms = 500): number {
  const [val, setVal] = useState(target ?? 0);
  const from = useRef(target ?? 0);
  const start = useRef(0);
  const raf = useRef(0);
  useEffect(() => {
    if (target == null) return;
    from.current = val;
    start.current = performance.now();
    cancelAnimationFrame(raf.current);
    const step = (now: number) => {
      const t = Math.min(1, (now - start.current) / ms);
      const eased = 1 - Math.pow(1 - t, 3);
      setVal(Math.round(from.current + (target - from.current) * eased));
      if (t < 1) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, ms]);
  return val;
}

export function useHashRoute(): string {
  const [hash, setHash] = useState(window.location.hash || "#/");
  useEffect(() => {
    const on = () => setHash(window.location.hash || "#/");
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash;
}
