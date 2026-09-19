import { useRef } from 'react'
import type { KeyboardEvent, PointerEvent } from 'react'
import { PANEL_MIN_WIDTH, clampPanelWidth } from './resize'

function lockBodyCursor(locked: boolean): void {
  if (typeof document === 'undefined') return
  document.body.style.cursor = locked ? 'col-resize' : ''
  document.body.style.userSelect = locked ? 'none' : ''
}

/**
 * The paper-thin seam between the center column and the inspector. Visually 1px,
 * functionally a 12px grab strip, and keyboard-operable so the width is not
 * mouse-only (arrows step 16px, shift-arrows 48px, Home/End jump to the bounds).
 */
export function ResizeHandle({
  width,
  max,
  onChange,
  label,
}: {
  width: number
  max: number
  onChange(width: number): void
  label: string
}) {
  const start = useRef<{ x: number; width: number } | null>(null)

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.focus()
    start.current = { x: event.clientX, width }
    lockBodyCursor(true)
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Pointer capture is an optimisation; dragging still works without it.
    }
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const origin = start.current
    if (!origin) return
    // The inspector lives on the right, so dragging left widens it.
    onChange(clampPanelWidth(origin.width + (origin.x - event.clientX), window.innerWidth))
  }

  const stop = (event: PointerEvent<HTMLDivElement>) => {
    start.current = null
    lockBodyCursor(false)
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
    } catch {
      // Nothing to release.
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 48 : 16
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      onChange(clampPanelWidth(width + step, window.innerWidth))
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      onChange(clampPanelWidth(width - step, window.innerWidth))
    } else if (event.key === 'Home') {
      event.preventDefault()
      onChange(clampPanelWidth(0, window.innerWidth))
    } else if (event.key === 'End') {
      event.preventDefault()
      onChange(clampPanelWidth(max, window.innerWidth))
    }
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={PANEL_MIN_WIDTH}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stop}
      onPointerCancel={stop}
      onLostPointerCapture={() => {
        start.current = null
        lockBodyCursor(false)
      }}
      onKeyDown={onKeyDown}
      className="relative z-20 w-px shrink-0 cursor-col-resize touch-none select-none bg-rule outline-offset-4 before:absolute before:inset-y-0 before:-left-1.5 before:-right-1.5 before:content-[''] hover:bg-rule-strong focus-visible:bg-accent"
    />
  )
}
