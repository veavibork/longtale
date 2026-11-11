import { useEffect, useState } from 'react'

/** Forces a re-render every `intervalMs` while `active` is true. */
export function useNowTick(active: boolean, intervalMs = 1000): number {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setTick((t) => t + 1), intervalMs)
    return () => clearInterval(id)
  }, [active, intervalMs])
  return tick
}
