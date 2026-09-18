import { useEffect, useRef } from 'react'

const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'mousemove', 'visibilitychange'] as const

export function useIdleLock(timeoutMinutes: number, enabled: boolean, onIdle: () => void) {
  const onIdleRef = useRef(onIdle)

  useEffect(() => {
    onIdleRef.current = onIdle
  }, [onIdle])

  useEffect(() => {
    if (!enabled || timeoutMinutes <= 0) return
    let timer: ReturnType<typeof setTimeout>

    const reset = () => {
      clearTimeout(timer)
      timer = setTimeout(() => onIdleRef.current(), timeoutMinutes * 60_000)
    }

    const onVisibility = () => {
      if (document.visibilityState === 'visible') reset()
    }

    reset()
    for (const event of ACTIVITY_EVENTS) {
      const target: EventTarget = event === 'visibilitychange' ? document : window
      target.addEventListener(event, event === 'visibilitychange' ? onVisibility : reset)
    }

    return () => {
      clearTimeout(timer)
      for (const event of ACTIVITY_EVENTS) {
        const target: EventTarget = event === 'visibilitychange' ? document : window
        target.removeEventListener(event, event === 'visibilitychange' ? onVisibility : reset)
      }
    }
  }, [timeoutMinutes, enabled])
}
