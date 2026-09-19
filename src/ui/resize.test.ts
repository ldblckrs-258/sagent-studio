import { describe, expect, it } from 'vitest'
import {
  PANEL_DEFAULT_WIDTH,
  PANEL_MIN_WIDTH,
  clampPanelWidth,
  panelWidthMax,
} from './resize'

describe('panelWidthMax', () => {
  it('is 60% of the viewport on a roomy viewport', () => {
    expect(panelWidthMax(1440)).toBe(864)
  })

  it('scales with a narrower viewport', () => {
    expect(panelWidthMax(1024)).toBe(614)
  })

  it('never returns less than the minimum', () => {
    expect(panelWidthMax(400)).toBe(PANEL_MIN_WIDTH)
  })

  it('falls back to the default without a measurable viewport', () => {
    expect(panelWidthMax(Number.NaN)).toBe(PANEL_DEFAULT_WIDTH)
    expect(panelWidthMax(0)).toBe(PANEL_DEFAULT_WIDTH)
  })
})

describe('clampPanelWidth', () => {
  it('clamps below the minimum up to the minimum', () => {
    expect(clampPanelWidth(120, 1440)).toBe(PANEL_MIN_WIDTH)
  })

  it('clamps above the 60vw bound down to that bound', () => {
    expect(clampPanelWidth(9999, 1440)).toBe(864)
    expect(clampPanelWidth(9999, 1024)).toBe(614)
  })

  it('keeps an in-range width and rounds it', () => {
    expect(clampPanelWidth(360.6, 1440)).toBe(361)
  })

  it('recovers the default from a non-finite width', () => {
    expect(clampPanelWidth(Number.NaN, 1440)).toBe(PANEL_DEFAULT_WIDTH)
  })
})
