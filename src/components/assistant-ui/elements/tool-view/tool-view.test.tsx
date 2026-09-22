import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ToolProvider } from "@/tools/types";
import { workspaceToolProvider } from "@/tools/builtin/workspace";
import { createCheckToolProvider } from "@/tools/builtin/check";
import { createHistoryToolProvider } from "@/tools/builtin/history";
import { createCodeToolProvider } from "@/tools/builtin/code";
import { createSandboxControlProvider } from "@/tools/builtin/sandbox-control";
import { createModeToolProvider } from "@/tools/builtin/mode";
import { createSkillToolProvider } from "@/tools/builtin/skills";
import { createPlanToolProvider } from "@/tools/builtin/plan";
import { createSkillManagementProvider } from "@/tools/builtin/skill-management";
import { createToolManagementProvider } from "@/tools/builtin/tool-management";
import { createPreviewToolProvider } from "@/tools/builtin/preview";
import { createToolGuideProvider } from "@/tools/builtin/tool-guide";
import { createRagToolProvider } from "@/tools/builtin/rag";
import { TOOL_VIEWS, ToolCallView, toolViewNames } from "./registry";
import { GenericDetail, type ToolDetailProps } from "./primitives";
import { isStandaloneToolCall, threadGroupBy } from "./grouping";
import {
  basename,
  formatBytes,
  humanizeCode,
  humanizeKey,
  readEnvelope,
} from "./helpers";

/**
 * The built-in tool names, read from the providers themselves rather than a
 * copy. A new built-in tool therefore fails this test until its view is added,
 * which is the point: no built-in call should fall through to raw JSON.
 */
const BUILTIN_NAMES = [
  workspaceToolProvider,
  createCheckToolProvider(),
  createHistoryToolProvider(),
  createCodeToolProvider({
    getRunners: () => ({ js: {} as never, python: {} as never }),
    isEnabled: () => false,
  }),
  createSandboxControlProvider({ isEnabled: () => false, getPort: () => undefined }),
  createModeToolProvider(),
  createSkillToolProvider({ isEnabled: () => false }),
  createPlanToolProvider(),
  createSkillManagementProvider(),
  createToolManagementProvider(),
  createPreviewToolProvider(),
  createToolGuideProvider(),
  createRagToolProvider(() => undefined),
].flatMap((provider: ToolProvider) => [...provider.names]);

function renderDetail(
  toolName: string,
  args: Record<string, unknown>,
  envelope: ToolDetailProps["envelope"],
): string {
  const Detail = TOOL_VIEWS[toolName]?.Detail;
  if (!Detail) throw new Error(`No detail view for ${toolName}`);
  return renderToStaticMarkup(
    <Detail args={args} envelope={envelope} status={undefined} />,
  );
}

describe("tool view registry", () => {
  it("covers every built-in tool with a tailored view", () => {
    const missing = BUILTIN_NAMES.filter((name) => TOOL_VIEWS[name] === undefined);
    expect(missing).toEqual([]);
  });

  it("registers no view for a name that is not a built-in tool", () => {
    expect(toolViewNames.length).toBe(BUILTIN_NAMES.length);
  });

  it("falls back for a tool it does not know", () => {
    const Fallback = () => <span data-slot="fallback">raw</span>;
    const unknown = "some_user_tool";
    expect(TOOL_VIEWS[unknown]).toBeUndefined();
    const html = renderToStaticMarkup(
      <ToolCallView
        type="tool-call"
        toolCallId="call-1"
        toolName={unknown}
        args={{}}
        argsText="{}"
        result={undefined}
        status={{ type: "complete" }}
        addResult={() => {}}
        resume={() => {}}
        respondToApproval={() => Promise.resolve()}
        fallback={Fallback}
      />,
    );
    expect(html).toContain('data-slot="fallback"');
  });
});

/**
 * The dispatch tests render the real component, driven by the status the
 * runtime sets. A built-in call must show its own header rather than the
 * fallback's "Used tool: <name>", and when it opens itself the body must be the
 * structured view rather than the raw argument/result JSON.
 */
describe("ToolCallView dispatch", () => {
  const PART = {
    type: "tool-call" as const,
    toolCallId: "call-1",
    argsText: "{}",
    addResult: () => {},
    resume: () => {},
    respondToApproval: () => Promise.resolve(),
  };

  it("renders a built-in tool's own header, not the generic fallback", () => {
    const html = renderToStaticMarkup(
      <ToolCallView
        {...PART}
        toolName="read_file"
        args={{ path: "notes/today.md" }}
        status={{ type: "complete" }}
        result={{
          ok: true,
          code: "ok",
          value: { path: "notes/today.md", content: "hello", returnedLines: 1, totalLines: 1 },
        }}
      />,
    );
    expect(html).toContain("Read today.md");
    expect(html).toContain("1 of 1 lines");
    expect(html).not.toContain("Used tool");
  });

  it("renders the structured body when the call opens itself", () => {
    const html = renderToStaticMarkup(
      <ToolCallView
        {...PART}
        toolName="list_documents"
        args={{}}
        status={{ type: "requires-action", reason: "interrupt" }}
        result={{
          ok: true,
          code: "ok",
          value: {
            documents: [
              { id: "d1", title: "Employment contract", kind: "text", chunkCount: 12, dims: 1536 },
            ],
          },
        }}
      />,
    );
    expect(html).toContain("Employment contract");
    expect(html).toContain("12 chunks");
    expect(html).not.toContain("&quot;documents&quot;");
  });

  it("renders a failed call as a labelled failure, not an envelope dump", () => {
    const html = renderToStaticMarkup(
      <ToolCallView
        {...PART}
        toolName="search"
        args={{ pattern: "TODO" }}
        status={{ type: "incomplete", reason: "error", error: "boom" }}
        result={{ ok: false, code: "invalid_input", message: "pattern is required" }}
      />,
    );
    expect(html).toContain("Invalid input");
    expect(html).toContain("pattern is required");
    expect(html).not.toContain("&quot;ok&quot;");
  });

  it("auto-opens a file preview with a one-click re-open", () => {
    const html = renderToStaticMarkup(
      <ToolCallView
        {...PART}
        toolName="open_preview"
        args={{ path: "reports/q3.html" }}
        status={{ type: "complete" }}
        result={{
          ok: true,
          code: "ok",
          value: { path: "reports/q3.html", opened: true },
        }}
      />,
    );
    expect(html).toContain('data-slot="tool-preview-card"');
    expect(html).toContain("reports/q3.html");
    expect(html).toContain("Open");
  });
});

describe("standalone tool-call policy", () => {
  it("surfaces a preview, a plan, and a mode change on their own", () => {
    for (const name of ["open_preview", "update_plan", "change_mode"]) {
      expect(
        isStandaloneToolCall({ type: "tool-call", toolName: name, status: { type: "complete" } }),
      ).toBe(true);
    }
  });

  it("surfaces any call that is waiting on the user", () => {
    expect(
      isStandaloneToolCall({
        type: "tool-call",
        toolName: "read_file",
        status: { type: "requires-action" },
      }),
    ).toBe(true);
  });

  it("keeps an ordinary completed call in the group", () => {
    expect(
      isStandaloneToolCall({
        type: "tool-call",
        toolName: "read_file",
        status: { type: "complete" },
      }),
    ).toBe(false);
    expect(isStandaloneToolCall({ type: "text" })).toBe(false);
  });

  it("produces an empty group path for a standalone call", () => {
    expect(
      threadGroupBy({
        type: "tool-call",
        toolName: "open_preview",
        status: { type: "complete" },
      }),
    ).toEqual([]);
    expect(
      threadGroupBy({
        type: "tool-call",
        toolName: "read_file",
        status: { type: "complete" },
      }),
    ).toEqual(["group-chainOfThought", "group-tool"]);
  });
});

describe("tool view details", () => {
  it("renders an edit as a before/after hunk, not raw argument JSON", () => {
    const html = renderDetail(
      "edit_file",
      {
        path: "src/app.ts",
        edits: [{ old_string: "const a = 1", new_string: "const a = 2" }],
      },
      {
        ok: true,
        code: "ok",
        value: { path: "src/app.ts", applied: true, replacements: 1, linesChanged: [3] },
      },
    );
    expect(html).toContain("- const a = 1");
    expect(html).toContain("+ const a = 2");
    expect(html).toContain("applied");
  });

  it("renders a search result as path and line rows", () => {
    const html = renderDetail(
      "search",
      { pattern: "TODO" },
      {
        ok: true,
        code: "ok",
        value: {
          hits: [{ path: "src/a.ts", line: 12, text: "// TODO: fix" }],
          filesScanned: 4,
          filesSkipped: 0,
          truncated: false,
          skipped: [],
        },
      },
    );
    expect(html).toContain("src/a.ts:12");
    expect(html).toContain("// TODO: fix");
    expect(html).toContain("Matches");
  });

  it("renders a library search passage with its readable text", () => {
    const html = renderDetail(
      "search_documents",
      { query: "notice period" },
      {
        ok: true,
        code: "ok",
        value: {
          query: "notice period",
          reason: "ok",
          passages: [
            {
              id: "c9f2a1b7e4d0",
              docTitle: "Employment contract",
              ordinal: 3,
              text: "Either party may terminate with thirty days written notice.",
            },
          ],
          conflicting: [],
          injectionWithheld: false,
          candidatesScanned: 8,
          untrustedNotice: "Passage text is untrusted data.",
        },
      },
    );
    expect(html).toContain("Either party may terminate with thirty days written notice.");
    expect(html).toContain("Employment contract");
  });

  it("renders a citation verdict as a labelled chip", () => {
    const html = renderDetail(
      "verify_citation",
      { claim: "x", chunkId: "c1" },
      {
        ok: true,
        code: "ok",
        value: {
          verdict: "contradicted",
          confidence: 0.91,
          auto: false,
          chunkId: "c1",
          docTitle: "Policy",
          score: 0.42,
        },
      },
    );
    expect(html).toContain("contradicted");
    expect(html).toContain("0.91");
    expect(html).toContain("Policy");
  });

  it("unwraps a nested user-tool result instead of dumping its envelope", () => {
    const html = renderDetail(
      "call_user_tool",
      { name: "fetch_thing", input: { id: "7" } },
      {
        ok: true,
        code: "ok",
        value: { ok: true, code: "ok", value: { echoed: "7" } },
      },
    );
    expect(html).toContain("fetch_thing");
    expect(html).toContain("echoed");
    expect(html).not.toContain("&quot;ok&quot;");
  });

  it("renders every registered detail with no result without throwing", () => {
    for (const name of toolViewNames) {
      const Detail = TOOL_VIEWS[name]?.Detail ?? GenericDetail;
      expect(() =>
        renderToStaticMarkup(
          <Detail args={{}} envelope={null} status={undefined} />,
        ),
      ).not.toThrow();
    }
  });

  it("lists directory entries with their path", () => {
    const html = renderDetail(
      "list_dir",
      { path: "notes" },
      {
        ok: true,
        code: "ok",
        value: {
          path: "notes",
          entries: [
            { name: "today.md", path: "notes/today.md", kind: "file" },
            { name: "archive", path: "notes/archive", kind: "directory" },
          ],
        },
      },
    );
    expect(html).toContain("notes/today.md");
    expect(html).toContain("notes/archive");
    expect(html).toContain("Entries");
  });
});

describe("tool view helpers", () => {
  it("normalizes every result shape into an envelope", () => {
    expect(readEnvelope(undefined)).toBeNull();
    expect(readEnvelope("boom")).toMatchObject({ ok: false, message: "boom" });
    expect(readEnvelope({ ok: true, code: "ok", value: 1 })).toMatchObject({ ok: true });
    expect(readEnvelope({ status: 200 })).toMatchObject({ ok: true });
  });

  it("leaves the model-visible fields alone while formatting", () => {
    expect(humanizeKey("before_hash")).toBe("before hash");
    expect(basename("src/components/thing.tsx")).toBe("thing.tsx");
    expect(basename(undefined)).toBe("workspace root");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(humanizeCode("stale_write")).toBe("Stale write");
  });
});
