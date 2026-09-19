export const PANEL_DEFAULT_WIDTH = 320
export const PANEL_MIN_WIDTH = 280

/** The inspector never exceeds this share of the viewport. */
export const PANEL_MAX_VIEWPORT_RATIO = 0.6

export function panelWidthMax(viewportWidth: number): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return PANEL_DEFAULT_WIDTH
  return Math.max(PANEL_MIN_WIDTH, Math.round(viewportWidth * PANEL_MAX_VIEWPORT_RATIO))
}

export function clampPanelWidth(width: number, viewportWidth: number): number {
  const safe = Number.isFinite(width) ? Math.round(width) : PANEL_DEFAULT_WIDTH
  return Math.min(Math.max(safe, PANEL_MIN_WIDTH), panelWidthMax(viewportWidth))
}
