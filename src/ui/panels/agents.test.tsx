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
  events: [
    { type: "text-delta", text: "scanning files" },
    { type: "tool-call", toolName: "read_file", toolCallId: "c1", input: {} },
  ],
  text: "scanning files",
  toolCalls: 1,
  approvals: [],
  startedAt: 1000,
}));

vi.mock("../../agents/store", () => ({
  agentRunStore: {
    list: () => [running],
    get: (runId: string) => (runId === running.runId ? running : undefined),
    pendingApprovals: () => [],
    pendingApprovalCount: () => 0,
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
}));

vi.mock("../../session/session-context", () => ({
  useSession: () => session,
}));

vi.mock("../agent-approval", () => ({
  AgentApprovalCard: () => null,
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

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === text,
  );
}

beforeEach(() => {
  useAgentPanelStore.getState().clear();
  session.steerAgentRun.mockClear();
  session.stopAgentRun.mockClear();
  session.cancelAgentRun.mockClear();
  session.stopAgentRun.mockReturnValue(true);
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("RunRow", () => {
  it("marks the selected row with aria-current and keeps stop for running runs", () => {
    const markup = renderToStaticMarkup(
      <RunRow
        title="scout"
        tier="high"
        mode="god"
        status="running"
        elapsedText="3s"
        selected
        onSelect={() => {}}
        onStop={() => {}}
      />,
    );
    expect(markup).toContain('aria-current="true"');
    expect(markup).toContain("Stop");
  });
});

describe("AgentsPanel", () => {
  it("selects a run, renders its flow, then returns to the list on back", async () => {
    const panel = await mount(<AgentsPanel />);
    const row = buttonByText(panel.container, "scout");
    expect(row).not.toBeUndefined();

    act(() => {
      row?.click();
    });
    expect(panel.container.querySelector("textarea")).not.toBeNull();
    expect(panel.container.textContent).toContain("scanning files");

    const back = panel.container.querySelector('[aria-label="Back to agent list"]');
    act(() => {
      (back as HTMLButtonElement).click();
    });
    const restored = buttonByText(panel.container, "scout");
    expect(restored).not.toBeUndefined();
    expect(panel.container.querySelector("textarea")).toBeNull();
    expect(document.activeElement).toBe(restored);

    panel.unmount();
  });

  it("force-stops a running run from its row", async () => {
    const panel = await mount(<AgentsPanel />);
    const stop = buttonByText(panel.container, "Stop");
    expect(stop).not.toBeUndefined();

    act(() => {
      stop?.click();
    });
    expect(session.stopAgentRun).toHaveBeenCalledWith("run-1");

    panel.unmount();
  });
});
