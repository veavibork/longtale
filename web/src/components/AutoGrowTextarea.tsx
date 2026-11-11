import { useLayoutEffect, useRef } from 'react'
import type { FocusEvent, KeyboardEvent, RefObject } from 'react'

/** Grows with its content instead of scrolling internally. */
export default function AutoGrowTextarea({
  value,
  onChange,
  onKeyDown,
  onFocus,
  className,
  placeholder,
  disabled,
  autoFocus,
  initialHeight,
  protectScrollRef,
}: {
  value: string
  onChange: (value: string) => void
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void
  onFocus?: (e: FocusEvent<HTMLTextAreaElement>) => void
  className?: string
  placeholder?: string
  disabled?: boolean
  autoFocus?: boolean
  initialHeight?: number
  protectScrollRef?: RefObject<HTMLElement | null>
}) {
  const ref = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const resize = () => {
      // Collapsing to "auto" below is necessary to detect shrinking content.
      const scrollTarget = protectScrollRef?.current
      const prevScrollTop = scrollTarget?.scrollTop

      // scrollHeight reflects whatever's rendered inside the box, including a wrapped placeholder.
      const placeholder = el.placeholder
      el.placeholder = ''
      el.style.height = 'auto'
      el.style.height = `${el.scrollHeight}px`
      el.placeholder = placeholder

      if (scrollTarget && prevScrollTop !== undefined) {
        scrollTarget.scrollTop = prevScrollTop
      }
    }
    resize()
    // Catches late metric shifts.
    const raf = requestAnimationFrame(resize)
    return () => cancelAnimationFrame(raf)
  }, [value, protectScrollRef])

  return (
    <textarea
      ref={(el) => {
        ref.current = el
        // Guards against re-applying on every render (callback refs re-fire then)
        if (el && initialHeight && !el.style.height) el.style.height = `${initialHeight}px`
      }}
      rows={1}
      className={className}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      placeholder={placeholder}
      disabled={disabled}
      autoFocus={autoFocus}
    />
  )
}
