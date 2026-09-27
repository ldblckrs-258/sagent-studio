# Phase 4 report: markdown rendering and tool-view visual sync

Status: completed.

## What landed

- `src/ui/markdown-prose.tsx` — the `COMPONENTS` map moved out of
  `file-view/markdown-view.tsx` and a `MarkdownProse({ children, className })`
  wrapper built on `react-markdown` + `remark-gfm`. No `rehype-raw`, no
  `dangerouslySetInnerHTML`; links keep `rel="noreferrer"`.
- `src/ui/agent-chips.tsx` — `TIERS`, `MODES`, `TIER_CHIP`, `MODE_CHIP`,
  `TierChip`, `ModeChip`, `readTier`/`readMode`, plus `asTier`/`asMode` for the
  panel's plain string fields. Single source for both the tool view and the
  panel.
- `file-view/markdown-view.tsx` now renders through `MarkdownProse` and imports
  nothing from `react-markdown` directly.
- `tool-view/details/agents.tsx` imports the shared chips, renders the returned
  reply with `MarkdownProse`, and adds tailored `stop_agent` and `read_agent`
  views (not empty) so every built-in tool keeps a view and the registry test
  passes. `read_agent` renders assistant/user turns through `MarkdownProse` and
  tool turns as code; `stop_agent` shows the run identity and stop reason.
- `sub-agent-report.aui.tsx` renders the response with `MarkdownProse`;
  `stopped` was already present in `STATUS_TONE`.
- `ui/panels/agents.tsx` replaces the plaintext `<pre>` with `MarkdownProse`,
  uses `ModeChip`/`TierChip` and a `numeric` elapsed value in the row, keeps the
  status tint map including `stopped`, and adds a visible focus ring to the row
  toggle.

## Tests

- `pnpm test src/ui/markdown-prose.test.tsx src/ui/panels/agents.test.tsx src/components/assistant-ui/elements/sub-agent-report.test.tsx src/components/assistant-ui/elements/tool-view/tool-view.test.tsx`
  — 4 files, 36 tests pass. New coverage: heading/list/fenced code, raw-HTML
  escaping, `rel="noreferrer"`, panel markdown replacing `<pre>`, report
  markdown and `stopped`, and the `stop_agent`/`read_agent` headers and details.
- `pnpm lint` — clean.
- `pnpm build` — clean.
- Full `pnpm test` — 131 files pass, 1 file fails (below).

## Known issue (out of scope, not owned by this phase)

`src/session/session.test.ts` has two failures at the `availableNames`
assertions: they still expect the pre-Phase-3 tool list and omit `stop_agent`
and `read_agent`. This is a Phase 3 gap — the file was already modified in the
working tree but those two expected arrays were not extended. It is not in this
phase's ownership list and not part of Phase 4 verification, so it was left
untouched. Stashing all working-tree changes makes it pass, confirming the
cause predates Phase 4.

## Next steps

- Phase 5 builds the master/detail flow on this shared `MarkdownProse` and
  `agent-chips` foundation.
- Whoever owns `session.test.ts` should add `stop_agent` and `read_agent` to
  the two `availableNames` expectations (and the disabled-runner variant).
