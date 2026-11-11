import { useEffect } from 'react'
import { fetchSettingsSpace } from '../api'

export const GLOBAL_CSS_SPACE = 'global-css'

export interface GlobalCssColors {
  text: string
  textH: string
  bg: string
  border: string
  codeBg: string
  accent: string
  accentBg: string
  accentBorder: string
}

export interface GlobalCssSettings {
  light: GlobalCssColors
  dark: GlobalCssColors
  rootFontSize: number
  rootFontSizeNarrow: number
  narrowBreakpoint: number
}

const STYLE_TAG_ID = 'global-css-overrides'

function colorVars(colors: GlobalCssColors): string {
  return `--text: ${colors.text}; --text-h: ${colors.textH}; --bg: ${colors.bg}; --border: ${colors.border}; --code-bg: ${colors.codeBg}; --accent: ${colors.accent}; --accent-bg: ${colors.accentBg}; --accent-border: ${colors.accentBorder};`
}

/** Mirrors index.css's `:root` custom properties + font-size/breakpoint rules with the given values. */
export function applyGlobalCssSettings(settings: GlobalCssSettings): void {
  let tag = document.getElementById(STYLE_TAG_ID) as HTMLStyleElement | null
  if (!tag) {
    tag = document.createElement('style')
    tag.id = STYLE_TAG_ID
    document.head.appendChild(tag)
  }
  tag.textContent = `
:root {
  ${colorVars(settings.light)}
  font-size: ${settings.rootFontSize}px;
}
@media (max-width: ${settings.narrowBreakpoint}px) {
  :root { font-size: ${settings.rootFontSizeNarrow}px; }
}
@media (prefers-color-scheme: dark) {
  :root {
    ${colorVars(settings.dark)}
  }
}
`.trim()
}

/** Applies the persisted Global CSS space once `enabled`. */
export function useGlobalCssSettings(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return
    void fetchSettingsSpace<GlobalCssSettings>(GLOBAL_CSS_SPACE)
      .then(applyGlobalCssSettings)
      .catch(() => {})
  }, [enabled])
}
