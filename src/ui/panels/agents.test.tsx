import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

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
  startedAt: Date.now(),
}));

vi.mock("../../agents/store", () => ({
  agentRunStore: {
    list: () => [running],
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

vi.mock("../../session/session-context", () => ({
  useSession: () => ({ cancelAgentRun: vi.fn() }),
}));

vi.mock("../agent-approval", () => ({
  AgentApprovalCard: () => null,
}));

import { AgentsPanel, RunRow } from "./agents";

describe("AgentsPanel", () => {
  it("renders a running run with its label, tier, status, and cancel action", () => {
    const markup = renderToStaticMarkup(<AgentsPanel />);
    expect(markup).toContain("scout");
    expect(markup).toContain("Prime");
    expect(markup).toContain("running");
    expect(markup).toContain("Cancel");
  });

  it("shows the transcript when a run is expanded", () => {
    const markup = renderToStaticMarkup(
      <RunRow
        title="scout"
        tier="high"
        mode="god"
        status="completed"
        elapsedText="3s"
        transcript="scanning files"
        expanded
        onToggle={() => {}}
      />,
    );
    expect(markup).toContain("scanning files");
    expect(markup).not.toContain("Cancel");
  });
});
