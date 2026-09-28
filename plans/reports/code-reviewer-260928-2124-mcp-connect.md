---
type: code-review
plan: ../260928-0526-mcp-connect/plan.md
date: 2026-09-28
status: fixed-with-open-items
---

# Code review: MCP connect

A fresh-context reviewer read the full diff and reproduced three findings with throwaway tests. It could not write files, so this report records its findings and the fix applied to each. After the fixes, `pnpm test` gives 1,902 passed and 1 skipped. `pnpm lint` and `pnpm exec tsc -b --noEmit` are clean.

## Findings and outcome

| ID | Severity | Finding | Outcome |
|----|----------|---------|---------|
| H1 | High | Under React StrictMode (the dev server), the effect cleanup disposed the manager for good. MCP stayed dead for the session and `hydrate()` rejected with nothing handling it. | Fixed. `McpConnectionManager.revive()` and an epoch counter make disposal reversible. `AppSession.startMcp()` revives, re-binds tools, and hydrates. `SessionProvider` calls it only while the effect is live. A stale hydrate is ignored. |
| H2 | High | Editing an OAuth server's URL kept its tokens, so `Authorization: Bearer <old token>` went to the new host. Cached discovery and registration also survived. | Fixed. OAuth state is cleared when the URL, proxy URL, client ID, client secret, or auth kind changes. A name, timeout, or tool-toggle edit keeps it. |
| M1 | Medium | Concurrent `list_changed` refreshes overwrote each other's catalog. | Fixed. Each refresh merges only its own lists into the current catalog. A per-kind sequence number drops stale results. |
| M2 | Medium | Saved approvals are keyed by the derived tool name. A later server with the same name, or the same server pointed at a new URL, inherited Allow decisions. | Fixed. Removing a server, changing its URL, or changing its name slug resets its `mcp_<slug>_*` decisions to `ask`, the default for MCP tools. |
| M3 | Medium | The sign-in popup kept `window.opener`, so a hostile authorization page could navigate the app tab. | Fixed. `popup.opener = null` right after opening. |
| M4 | Medium | Tool input schemas, `structuredContent`, and content lists had no size cap. | Fixed. Schemas over 20,000 characters are skipped with a reason. `structuredContent` over 100,000 characters is dropped. Content lists are cut to 50 items. Each case sets `truncated`. |
| M5 | Medium | A background connect could overwrite an in-progress sign-in's PKCE verifier. | Fixed. Only an interactive (sign-in) provider stores a verifier. |
| M6 | Medium | `read_mcp_resource` is ungated, so a template URI could carry data to a server without a prompt. | Not changed. This follows the user's 2026-09-28 decision. Open question below. |
| L1 | Low | A superseded sign-in left its popup open. | Fixed. |
| L2 | Low | A proxy URL without a trailing separator was joined into an invalid URL. | Fixed. Validation requires the proxy URL to end with `/`, `?`, or `=`. |
| L3 | Low | Two parallel calls that both get a 404 each reconnect. | Not changed. Plausible but not reproduced. The second call fails with a clear error. |
| L4 | Low | Resource templates were not refreshed on `resources/list_changed`. | Fixed as part of M1. |
| L5 | Low | One bad record hides every server. | Not changed. This matches the memory store. The error is shown in the panel. |
| L6 | Low | Reading a resource for an attachment had no abort signal, so a slow server could hold the send for up to `timeoutMs`. | Fixed. The read has a 15-second limit and degrades to a `missing` marker. |
| L7 | Low | The egress notice still said keys never leave. | Fixed. The notice says MCP headers and tokens go to their server and its proxy. |
| L8 | Low | The `hasTool` JSDoc line in `registry.ts` was edited. | Kept. The old text had become inaccurate. No new comments were added. |
| L9 | Low | The one-reconnect flag never resets. | Not changed. Plausible only. After a second drop the server shows an error and **Reconnect** works. |

## Unresolved questions

- M6: should `read_mcp_resource` ask for approval when the URI is not one of the listed resources, i.e. a template expansion by the model?
- Should renaming a server carry its saved approvals over to the new tool names? Today they reset to `ask`, which is safe but loses the user's choices.
