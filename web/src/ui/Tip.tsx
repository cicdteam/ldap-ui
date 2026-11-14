import { useEffect, useId, useRef, useState, type CSSProperties, type SyntheticEvent } from 'react'
import { createPortal } from 'react-dom'

/** How long the pointer rests on a control before its tip shows; the native title waits ~1 s. */
export const TIP_DELAY = 150
const EDGE = 160

/** Below the control, or above it near the window's bottom; kept inside the window. */
function place(r: DOMRect): CSSProperties {
  const style: CSSProperties =
    r.bottom + 40 > innerHeight ? { bottom: innerHeight - r.top + 4 } : { top: r.bottom + 4 }
  const center = (r.left + r.right) / 2
  if (center > innerWidth - EDGE) return { ...style, right: innerWidth - r.right }
  if (center < EDGE) return { ...style, left: r.left }
  return { ...style, left: center, transform: 'translateX(-50%)' }
}

/**
 * A quick tooltip for a control: shows after TIP_DELAY on hover or keyboard focus, in a portal so
 * no panel clips it. Spread `on` onto the control and render `node` next to it.
 */
export function useTip(text: string | undefined) {
  const id = useId()
  const [at, setAt] = useState<DOMRect | null>(null)
  const timer = useRef(0)
  useEffect(() => () => clearTimeout(timer.current), [])
  const show = (e: SyntheticEvent<HTMLElement>, keyboard: boolean) => {
    const el = e.currentTarget
    if (!text || (keyboard && !el.matches(':focus-visible'))) return
    clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setAt(el.getBoundingClientRect()), TIP_DELAY)
  }
  const hide = () => {
    clearTimeout(timer.current)
    setAt(null)
  }
  return {
    on: {
      onPointerEnter: (e: SyntheticEvent<HTMLElement>) => show(e, false),
      onPointerLeave: hide,
      onPointerDown: hide,
      onFocus: (e: SyntheticEvent<HTMLElement>) => show(e, true),
      onBlur: hide,
    },
    describedBy: at && text ? id : undefined,
    node:
      at && text
        ? createPortal(
            <div
              id={id}
              role="tooltip"
              style={place(at)}
              className="pointer-events-none fixed z-50 max-w-xs rounded bg-fg px-2 py-1 text-xs text-bg shadow-lg"
            >
              {text}
            </div>,
            document.body,
          )
        : null,
  }
}
