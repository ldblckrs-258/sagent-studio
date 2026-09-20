// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

const mermaidMock = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }))

vi.mock('mermaid', () => ({ default: mermaidMock }))

import { loadMermaid, sanitizeDiagramSvg } from './diagram'

describe('sanitizeDiagramSvg', () => {
  it('strips a script node and event handlers from a hostile label', async () => {
    const hostile =
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">' +
      '<script>alert(1)</script><text>hi</text></svg>'
    const clean = await sanitizeDiagramSvg(hostile)
    expect(clean).not.toContain('<script')
    expect(clean).not.toContain('onload')
  })

  it('preserves benign SVG structure', async () => {
    const benign =
      '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"></rect>' +
      '<text x="1" y="1">ok</text></svg>'
    const clean = await sanitizeDiagramSvg(benign)
    expect(clean).toContain('<rect')
    expect(clean).toContain('<text')
    expect(clean).toContain('ok')
  })
})

describe('loadMermaid', () => {
  it('initializes once with strict security and no auto-run', async () => {
    await loadMermaid()
    expect(mermaidMock.initialize).toHaveBeenCalledWith({
      startOnLoad: false,
      securityLevel: 'strict',
    })
  })
})
