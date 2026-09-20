/**
 * `allow-same-origin` is enabled by explicit product decision. It unlocks
 * modules, `fetch`, storage, and workers for previewed HTML; `allow-scripts`
 * plus `allow-same-origin` also lets the frame drop its own sandbox. Workspace
 * files are injected with `srcdoc`, so they inherit the app origin and can reach
 * the app's DOM and storage. Remote links keep their own origin. Only preview
 * HTML you trust.
 */
export const PREVIEW_SANDBOX =
  'allow-scripts allow-same-origin allow-forms allow-popups allow-modals'

/**
 * Sandbox for HTML the model has authored this session. `allow-same-origin` is
 * deliberately absent: the frame gets an opaque origin, so its scripts cannot
 * read app-origin storage or reach the parent DOM. The document is served from a
 * blob URL with its inline scripts externalized to blob scripts, because a
 * `srcdoc` document inherits the parent policy but cannot be given a distinct one.
 */
export const ARTIFACT_PREVIEW_SANDBOX = 'allow-scripts allow-forms allow-popups allow-modals'
