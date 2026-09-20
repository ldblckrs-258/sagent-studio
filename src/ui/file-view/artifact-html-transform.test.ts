// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ARTIFACT_PREVIEW_SANDBOX,
  externalizeInlineScripts,
  revokeAll,
} from './artifact-html-transform'

let counter = 0

beforeEach(() => {
  counter = 0
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => `blob:artifact-${counter++}`),
    revokeObjectURL: vi.fn(),
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function scriptSources(html: string): string[] {
  const document = new DOMParser().parseFromString(html, 'text/html')
  return Array.from(document.querySelectorAll('script[src]')).map(
    (script) => script.getAttribute('src') ?? '',
  )
}

describe('externalizeInlineScripts', () => {
  it('rewrites one inline script to an external blob script', () => {
    const result = externalizeInlineScripts('<div id="out">ok</div><script>run()</script>')
    expect(result.urls).toEqual(['blob:artifact-0'])
    expect(scriptSources(result.html)).toEqual(['blob:artifact-0'])
    expect(result.html).not.toContain('run()')
  })

  it('leaves an external script and a data block untouched', () => {
    const result = externalizeInlineScripts(
      '<script src="https://x.test/a.js"></script><script type="application/json">{"a":1}</script>',
    )
    expect(result.urls).toEqual([])
    expect(result.html).toContain('src="https://x.test/a.js"')
    expect(result.html).toContain('type="application/json"')
    expect(result.html).toContain('{"a":1}')
  })

  it('preserves execution order across two inline scripts', () => {
    const result = externalizeInlineScripts('<script>first()</script><script>second()</script>')
    expect(result.urls).toEqual(['blob:artifact-0', 'blob:artifact-1'])
    expect(scriptSources(result.html)).toEqual(['blob:artifact-0', 'blob:artifact-1'])
  })

  it('keeps a module script a module', () => {
    const result = externalizeInlineScripts('<script type="module">export const x = 1</script>')
    const document = new DOMParser().parseFromString(result.html, 'text/html')
    expect(document.querySelector('script')?.getAttribute('type')).toBe('module')
  })

  it('skips an empty inline script', () => {
    const result = externalizeInlineScripts('<script>   </script>')
    expect(result.urls).toEqual([])
  })
})

describe('revokeAll', () => {
  it('revokes every created URL', () => {
    const revoke = vi.mocked(URL.revokeObjectURL)
    revokeAll(['blob:a', 'blob:b'])
    expect(revoke).toHaveBeenCalledTimes(2)
    expect(revoke).toHaveBeenCalledWith('blob:a')
    expect(revoke).toHaveBeenCalledWith('blob:b')
  })
})

describe('ARTIFACT_PREVIEW_SANDBOX', () => {
  it('never grants a same-origin frame', () => {
    expect(ARTIFACT_PREVIEW_SANDBOX).not.toContain('allow-same-origin')
    expect(ARTIFACT_PREVIEW_SANDBOX).toContain('allow-scripts')
  })
})
