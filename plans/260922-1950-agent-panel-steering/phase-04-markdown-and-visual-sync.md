---
phase: 4
title: "Markdown rendering and tool-view visual sync"
status: pending
priority: P1
effort: 1d
dependencies: []
---

# Phase 4: Markdown rendering and tool-view visual sync

## Goal

Render every sub-agent response as markdown and give the Agents panel the same
visual language as the `spawn_agent` tool-call view.

## Overview

Three surfaces print sub-agent output as plaintext: the panel transcript, the
tool-call detail reply, and the background-report card. Extract one markdown
renderer usable outside the assistant-ui runtime, extract the tier/mode chips
shared with the tool-call view, and apply both everywhere.

## Key Insights

- **The panel is outside the runtime.** Right-rail panels render beside
  `AssistantRuntimeProvider`, so `MarkdownText` (which needs a message-part
  context) cannot be used. Use `react-markdown` + `remark-gfm` directly, the way
  `src/ui/file-view/markdown-view.tsx` already does, with a shared components
  map.
- **The tool detail is also not a text part.** `tool-view/details/agents.tsx`
  renders inside a tool-call part, not a text part, so it too must use the
  direct renderer.
- **`react-markdown` escapes raw HTML** and `rehype-raw` stays off; model output
  cannot inject markup. Keep that property.
- **DRY the chips.** `TierChip`, `ModeChip`, `TIER_CHIP`, and `MODE_CHIP` live in
  `tool-view/details/agents.tsx`. Extract them to a shared module so the panel
  and the tool view cannot drift.
- **Design language.** Reuse the tool-view vocabulary: tier chip, mode chip,
  hairline `ActDivider` separators, `border-rule bg-surface` cards, `label-micro`
  headings, `numeric` mono values, and the `ease-out-quart` transitions already
  used across the shell. Product register: 150-250ms state transitions only,
  visible focus rings, 44px touch targets on controls, reduced-motion honoured.

## Requirements

- New `src/ui/markdown-prose.tsx` exports a `MarkdownProse` component built on
  `react-markdown` with the shared `COMPONENTS` map (moved or reused from
  `markdown-view.tsx` without behaviour change).
- New `src/ui/agent-chips.tsx` exports `TierChip`, `ModeChip`, and the tier/mode
  metadata used by both the tool view and the panel.
- `src/components/assistant-ui/elements/tool-view/details/agents.tsx` imports the
  shared chips and renders the returned reply with `MarkdownProse`.
- `src/components/assistant-ui/elements/sub-agent-report.aui.tsx` renders the
  report response with `MarkdownProse` and includes `stopped` in its status map.
- `src/ui/panels/agents.tsx` renders the transcript with `MarkdownProse` and
  adopts the chip/divider vocabulary (full master/detail is Phase 5; this phase
  only swaps the plaintext `<pre>` and row chrome).
- No raw `#000`/`#fff`; tokens only.

## Files to Create / Modify

- Create: `src/ui/markdown-prose.tsx`
- Create: `src/ui/markdown-prose.test.tsx`
- Create: `src/ui/agent-chips.tsx`
- Modify: `src/ui/file-view/markdown-view.tsx` (reuse the shared components map)
- Modify: `src/components/assistant-ui/elements/tool-view/details/agents.tsx`
- Modify: `src/components/assistant-ui/elements/tool-view/tool-view.test.tsx`
- Modify: `src/components/assistant-ui/elements/sub-agent-report.aui.tsx`
- Modify: `src/components/assistant-ui/elements/sub-agent-report.test.tsx`
- Modify: `src/ui/panels/agents.tsx`
- Modify: `src/ui/panels/agents.test.tsx`

## Implementation Steps

1. Create `markdown-prose.tsx`: move the `COMPONENTS` map from
   `markdown-view.tsx` into it, export `MarkdownProse({ children, className })`
   that renders `<Markdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>`,
   and have `markdown-view.tsx` import the shared map.
2. Create `agent-chips.tsx`: move `TIER_CHIP`, `MODE_CHIP`, `TierChip`,
   `ModeChip`, and the tier/mode readers from `details/agents.tsx`; re-export so
   imports stay stable.
3. Update `details/agents.tsx` `Outcome` to render `response` through
   `MarkdownProse` inside the existing reply card.
4. Update `sub-agent-report.aui.tsx` to render `report.response` through
   `MarkdownProse` and to add `stopped: { label: 'Stopped', tone: 'neutral' }`
   (or `caution`) to `STATUS_TONE`.
5. Update `panels/agents.tsx`: replace the `<pre>` transcript with
   `MarkdownProse`, show the tier/mode chips and an elapsed value in the row
   using the shared chips, and keep the status tint map including `stopped`.
6. Tests: `markdown-prose.test.tsx` renders a heading, list, and fenced code
   from a string and asserts no raw HTML is injected. Panel and tool-view tests
   assert markdown output replaces the plaintext node.

## Verification

- `pnpm test src/ui/markdown-prose.test.tsx src/ui/panels/agents.test.tsx src/components/assistant-ui/elements/sub-agent-report.test.tsx src/components/assistant-ui/elements/tool-view/tool-view.test.tsx`
- `pnpm lint && pnpm build`

## Success Criteria

- A sub-agent response with headings, lists, or code renders formatted in the
  panel, the tool-call detail, and the background report card.
- Tier and mode chips come from one shared source.
- Keyboard focus is visible and motion respects `prefers-reduced-motion`.

## Risk Assessment

- **XSS:** `react-markdown` escapes HTML by default; never enable `rehype-raw`
  for model output.
- **Style drift:** keep the shared components map single-sourced; a second copy
  will diverge.

## Security Considerations

- Model-authored markdown is untrusted; no raw HTML, no `dangerouslySetInnerHTML`,
  links get `rel="noreferrer"`.

## Next Steps

- Phase 5 builds the master/detail flow view on this shared foundation.
