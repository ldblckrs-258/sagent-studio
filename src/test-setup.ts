import 'fake-indexeddb/auto'

// jsdom lacks the layout APIs assistant-ui's message viewport touches, so any
// test that mounts the thread runtime needs these stubs.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
}

if (typeof Element !== 'undefined') {
  const element = Element.prototype as Element & {
    scrollTo?: (...args: unknown[]) => void
    scrollIntoView?: (...args: unknown[]) => void
  }
  if (typeof element.scrollTo !== 'function') element.scrollTo = () => {}
  if (typeof element.scrollIntoView !== 'function') element.scrollIntoView = () => {}
}
