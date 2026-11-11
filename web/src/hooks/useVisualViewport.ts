import { useEffect } from 'react'

const CSS_VAR = '--app-height'

/** Tracks `window.visualViewport`'s height into a CSS custom property. */
export function useVisualViewport(): void {
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return

    function update() {
      document.documentElement.style.setProperty(CSS_VAR, `${vv!.height}px`)
    }

    update()
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
      document.documentElement.style.removeProperty(CSS_VAR)
    }
  }, [])
}
