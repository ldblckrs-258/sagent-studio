// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const running = vi.hoisted(() => ({
  runId: "run-1",
  parentThreadId: "t1",
  label: "scout",
  mode: "god",
  tier: "high",
  status: "running",
  prompt: "map the repo",
  messages: [
    { id: "run-1-prompt", role: "user", parts: [{ type: "text", text: "map the repo" }] },
    {
      id: "run-1-a0",
      role: "assistant",
      parts: [
        {
          type: "tool-list_dir",
          toolCallId: "c1",
          state: "input-available",
          input: { path: "src" },
        },
      ],
    },
  ],
  text: "",
  toolCalls: 1,
  approvals: [],
  startedAt: 1000,
}));

const awaitingApproval = vi.hoisted(() => ({
  runId: "run-2",
  parentThreadId: "t1",
  label: "reviewer",
  mode: "editing",
  tier: "medium",
  status: "interrupted",
  prompt: "review the diff",
  messages: [
    { id: "run-2-prompt", role: "user", parts: [{ type: "text", text: "review the diff" }] },
  ],
  text: "",
  toolCalls: 0,
  approvals: [{ id: "a1", runId: "run-2", toolName: "write_file", input: {} }],
  startedAt: 2000,
}));

vi.mock("../../agents/store", () => ({
  agentRunStore: {
    list: () => [running, awaitingApproval],
    get: (runId: string) =>
      [running, awaitingApproval].find((run) => run.runId === runId),
    pendingApprovals: () => awaitingApproval.approvals,
    pendingApprovalCount: () => awaitingApproval.approvals.length,
    subscribe: () => () => {},
    getVersion: () => 1,
    resolveApproval: vi.fn(),
  },
}));

vi.mock("../../chat/persistence", () => ({
  listAgentRuns: async () => [],
}));

vi.mock("../../chat/store", () => ({
  useChatStore: (selector: (slice: { activeThreadId: string }) => unknown) =>
    selector({ activeThreadId: "t1" }),
}));

const session = vi.hoisted(() => ({
  steerAgentRun: vi.fn(() => true),
  stopAgentRun: vi.fn(() => true),
  cancelAgentRun: vi.fn(),
  agentProfiles: {
    subscribe: () => () => {},
    getVersion: () => 0,
    loadErrors: vi.fn((): Array<{ path: string; message: string }> => []),
  },
}));

vi.mock("../../session/session-context", () => ({
  useSession: () => session,
}));

vi.mock("../agent-approval", () => ({
  AgentApprovalCard: ({ label }: { label?: string }) => (
    <div data-slot="approval-card">{label}</div>
  ),
}));

import { useAgentPanelStore } from "../../session/agent-panel-state";
import { AgentsPanel, RunRow } from "./agents";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function mount(node: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  return {
    container,
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

beforeEach(() => {
  useAgentPanelStore.getState().clear();
  session.steerAgentRun.mockClear();
  session.stopAgentRun.mockClear();
  session.cancelAgentRun.mockClear();
  session.stopAgentRun.mockReturnValue(true);
  session.agentProfiles.loadErrors.mockReturnValue([]);
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("RunRow", () => {
  it("shows the run's profile as a chip next to its tier", () => {
    const withProfile = renderToStaticMarkup(
      <RunRow
        title="audit"
        profile="reviewer"
        tier="high"
        status="completed"
        activity=""
        toolCalls={0}
        elapsedText="3s"
        selected={false}
        onSelect={() => {}}
      />,
    );
    const without = renderToStaticMarkup(
      <RunRow
        title="audit"
        tier="high"
        status="completed"
        activity=""
        toolCalls={0}
        elapsedText="3s"
        selected={false}
        onSelect={() => {}}
      />,
    );
    expect(withProfile).toContain('data-slot="agent-profile-chip"');
    expect(withProfile).toContain("reviewer");
    expect(without).not.toContain('data-slot="agent-profile-chip"');
  });

  it("marks the selected row with aria-current and keeps a stop button for a running run", () => {
    const markup = renderToStaticMarkup(
      <RunRow
        title="scout"
        tier="high"
        status="running"
        activity="Listed src"
        toolCalls={1}
        elapsedText="3s"
        selected
        onSelect={() => {}}
        onStop={() => {}}
      />,
    );
    expect(markup).toContain('aria-current="true"');
    expect(markup).toContain("Listed src");
    expect(markup).toContain('aria-label="Stop agent run"');
  });

  it("shows a pending-approval badge and no stop button for a settled run", () => {
    const markup = renderToStaticMarkup(
      <RunRow
        title="reviewer"
        tier="medium"
        status="completed"
        activity="Done."
        toolCalls={2}
        elapsedText="10s"
        hasApproval
        selected={false}
        onSelect={() => {}}
      />,
    );
    expect(markup).toContain("approval");
    expect(markup).not.toContain('aria-label="Stop agent run"');
  });
});

describe("AgentsPanel", () => {
  it("groups a running run and a settled run awaiting approval under Active", async () => {
    const panel = await mount(<AgentsPanel />);
    const activeHeading = Array.from(panel.container.querySelectorAll("p")).find((node) =>
      node.textContent?.startsWith("Active"),
    );
    expect(activeHeading?.textContent).toContain("2");
    expect(panel.container.textContent).toContain("scout");
    expect(panel.container.textContent).toContain("reviewer");
    expect(panel.container.textContent).toContain("approval");
    expect(panel.container.querySelectorAll('[aria-label="Stop agent run"]')).toHaveLength(1);
    panel.unmount();
  });

  it("shows the running tool's label as the row's activity line", async () => {
    const panel = await mount(<AgentsPanel />);
    expect(panel.container.textContent).toContain("Listed src");
    panel.unmount();
  });

  it("opens a run in the shared panel store instead of rendering it in place", async () => {
    const panel = await mount(<AgentsPanel />);
    const row = Array.from(panel.container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("scout"),
    );
    expect(row).not.toBeUndefined();

    act(() => {
      row?.click();
    });

    expect(useAgentPanelStore.getState().selectedRunId).toBe("run-1");
    expect(panel.container.querySelector("textarea")).toBeNull();
    panel.unmount();
  });

  it("highlights the selected row without rendering an inline run view", async () => {
    useAgentPanelStore.getState().open("run-1");
    const panel = await mount(<AgentsPanel />);
    const selected = panel.container.querySelector('[aria-current="true"]');
    expect(selected?.textContent).toContain("scout");
    expect(panel.container.querySelector("textarea")).toBeNull();
    panel.unmount();
  });

  it("force-stops a running run from its row", async () => {
    const panel = await mount(<AgentsPanel />);
    const stop = panel.container.querySelector('[aria-label="Stop agent run"]');
    expect(stop).not.toBeNull();

    act(() => {
      (stop as HTMLButtonElement).click();
    });
    expect(session.stopAgentRun).toHaveBeenCalledWith("run-1");

    panel.unmount();
  });

  it("reports a broken workspace profile file so its author can fix it", async () => {
    session.agentProfiles.loadErrors.mockReturnValue([
      { path: ".agents/agents/broken.md", message: '"mode" must be one of read_only, editing, god.' },
    ]);
    const panel = await mount(<AgentsPanel />);
    const alert = panel.container.querySelector('[data-slot="agent-profile-errors"]');
    expect(alert?.textContent).toContain(".agents/agents/broken.md");
    expect(alert?.textContent).toContain('"mode"');
    panel.unmount();
  });
});
