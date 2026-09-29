// @vitest-environment jsdom
import type { UIMessage } from "ai";
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunRecord } from "../agents/store";
import type { ChatThread } from "../chat/types";

const store = vi.hoisted(() => ({ record: undefined as unknown }));

vi.mock("../agents/store", () => ({
  agentRunStore: {
    get: () => store.record,
    list: () => (store.record ? [store.record] : []),
    pendingApprovals: () => [],
    subscribe: () => () => {},
    getVersion: () => 1,
  },
}));

const persisted = vi.hoisted(() => ({ thread: null as unknown }));

vi.mock("../chat/persistence", () => ({
  loadThread: async () => persisted.thread,
}));

const session = vi.hoisted(() => ({
  steerAgentRun: vi.fn(() => true),
  stopAgentRun: vi.fn(() => true),
  continueAgentRun: vi.fn(async () => ({ status: "running", runId: "run-1" }) as { status: string; runId?: string; message?: string }),
  terminal: { sessions: () => [], killOwned: async () => [] },
}));

vi.mock("../session/session-context", () => ({
  useSession: () => session,
}));

vi.mock("./agent-approval", () => ({
  AgentApprovalCard: () => null,
}));

import { SubAgentReport } from "../components/assistant-ui/elements/sub-agent-report.aui";
import { useAgentPanelStore } from "../session/agent-panel-state";
import { AgentRunView } from "./agent-run-view";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Part = UIMessage["parts"][number];

const prompt: UIMessage = { id: "p", role: "user", parts: [{ type: "text", text: "map the repo" }] };

function assistant(parts: unknown[], id = "a"): UIMessage {
  return { id, role: "assistant", parts: parts as Part[] };
}

const listDirCall = { type: "tool-list_dir", toolCallId: "c1", state: "input-available", input: {} };
const listDirDone = {
  ...listDirCall,
  state: "output-available",
  output: { ok: true, code: "ok", value: { entries: [{ path: "a.ts" }, { path: "b.ts" }] } },
};

function record(overrides: Partial<AgentRunRecord> = {}): AgentRunRecord {
  return {
    runId: "run-1",
    parentThreadId: "t1",
    label: "scout",
    mode: "god",
    tier: "high",
    status: "running",
    prompt: "map the repo",
    messages: [prompt, assistant([{ type: "text", text: "scanning files" }])],
    text: "",
    toolCalls: 0,
    approvals: [],
    startedAt: 1000,
    ...overrides,
  };
}

function childThread(messages: UIMessage[]): ChatThread {
  return {
    id: "run-1",
    title: "scout",
    messages,
    config: { providerId: "p", params: {} } as unknown as ChatThread["config"],
    createdAt: 1000,
    updatedAt: 5000,
    agent: { runId: "run-1", parentThreadId: "t1", label: "scout", mode: "god", tier: "high", status: "completed" },
  };
}

function mount(node: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return {
    container,
    rerender(next: ReactNode) {
      act(() => {
        root.render(next);
      });
    },
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function typeInto(element: HTMLTextAreaElement, value: string): void {
  element.focus();
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

function byLabel(container: HTMLElement, label: string): HTMLButtonElement | null {
  return container.querySelector(`[aria-label="${label}"]`);
}

function textarea(container: HTMLElement): HTMLTextAreaElement {
  return container.querySelector("textarea") as HTMLTextAreaElement;
}

beforeEach(() => {
  store.record = undefined;
  persisted.thread = null;
  session.steerAgentRun.mockClear();
  session.stopAgentRun.mockClear();
  session.steerAgentRun.mockReturnValue(true);
  session.stopAgentRun.mockReturnValue(true);
  session.continueAgentRun.mockClear();
  session.continueAgentRun.mockResolvedValue({ status: "running", runId: "run-1" });
  useAgentPanelStore.getState().open("run-1");
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("AgentRunView", () => {
  it("shows a tool call as running, not as a pending approval, until its result lands", () => {
    store.record = record({ messages: [prompt, assistant([listDirCall])] });
    const view = mount(<AgentRunView runId="run-1" />);

    expect(view.container.textContent).toContain("Listed the workspace root");
    expect(view.container.textContent).not.toContain("Allow");
    expect(view.container.textContent).not.toContain("Deny");

    store.record = record({ messages: [prompt, assistant([listDirDone])] });
    view.rerender(<AgentRunView runId="run-1" />);
    expect(view.container.textContent).toContain("2 entries");
    view.unmount();
  });

  it("shows the real result of a persisted run after a reload", async () => {
    persisted.thread = childThread([prompt, assistant([listDirDone, { type: "text", text: "done" }])]);
    const view = mount(<AgentRunView runId="run-1" />);
    await flush();

    expect(view.container.textContent).toContain("2 entries");
    expect(view.container.textContent).not.toContain("0 entries");
    view.unmount();
  });

  it("says a legacy run's lost result was not recorded instead of showing zero entries", async () => {
    persisted.thread = childThread([
      prompt,
      assistant([{ type: "dynamic-tool", toolName: "list_dir", toolCallId: "c1", state: "output-available", input: {}, output: {} }]),
    ]);
    const view = mount(<AgentRunView runId="run-1" />);
    await flush();

    expect(view.container.textContent).not.toContain("0 entries");
    act(() => {
      (view.container.querySelector('[data-slot="tool-view-trigger"]') as HTMLButtonElement).click();
    });
    expect(view.container.textContent).toContain("The result of this call was not recorded.");
    view.unmount();
  });

  it("offers no regenerate or edit on a run's messages", () => {
    store.record = record({ status: "completed", endedAt: 3000 });
    const view = mount(<AgentRunView runId="run-1" />);

    expect(view.container.querySelector('[aria-label="Refresh"]')).toBeNull();
    expect(view.container.querySelector(".aui-user-action-edit")).toBeNull();
    view.unmount();
  });

  it("steers the run from the composer and echoes the message until the run records it", async () => {
    store.record = record();
    const view = mount(<AgentRunView runId="run-1" />);
    const field = textarea(view.container);
    expect(field.disabled).toBe(false);

    act(() => typeInto(field, "hold on"));
    await act(async () => {
      byLabel(view.container, "Send steering message")?.click();
    });

    expect(session.steerAgentRun).toHaveBeenCalledWith("run-1", "hold on");
    expect(view.container.textContent).toContain("hold on");

    store.record = record({ status: "completed", endedAt: 3000 });
    view.rerender(<AgentRunView runId="run-1" />);
    expect(view.container.textContent).not.toContain("hold on");
    view.unmount();
  });

  it("keeps a running tool as running while a steer waits for the next step", async () => {
    store.record = record({ messages: [prompt, assistant([listDirCall])] });
    const view = mount(<AgentRunView runId="run-1" />);

    act(() => typeInto(textarea(view.container), "also check tests"));
    await act(async () => {
      byLabel(view.container, "Send steering message")?.click();
    });

    expect(view.container.querySelector('[data-slot="pending-steers"]')?.textContent).toContain(
      "also check tests",
    );
    expect(view.container.textContent).not.toContain("Allow");
    expect(view.container.textContent).not.toContain("Deny");
    view.unmount();
  });

  it("sends on Enter and leaves Shift+Enter for a newline", async () => {
    store.record = record();
    const view = mount(<AgentRunView runId="run-1" />);
    const field = textarea(view.container);

    act(() => {
      typeInto(field, "one");
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
    });
    expect(session.steerAgentRun).not.toHaveBeenCalled();

    await act(async () => {
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(session.steerAgentRun).toHaveBeenCalledWith("run-1", "one");
    view.unmount();
  });

  it("stops the run and closes steering while it stops", async () => {
    store.record = record();
    const view = mount(<AgentRunView runId="run-1" />);

    await act(async () => {
      byLabel(view.container, "Stop agent run")?.click();
    });

    expect(session.stopAgentRun).toHaveBeenCalledWith("run-1");
    expect(view.container.textContent).toContain("stopping");
    expect(textarea(view.container).disabled).toBe(true);

    store.record = record({ status: "stopped", stopReason: "user_stop", endedAt: 3000 });
    view.rerender(<AgentRunView runId="run-1" />);
    expect(textarea(view.container).placeholder).toContain("You stopped this run");
    view.unmount();
  });

  it("closes the composer with a reason once a legacy run without a spec is settled", () => {
    store.record = record({ status: "completed", endedAt: 3000 });
    const view = mount(<AgentRunView runId="run-1" />);

    expect(textarea(view.container).disabled).toBe(true);
    expect(textarea(view.container).placeholder).toContain("This run finished");
    expect(textarea(view.container).placeholder).toContain("before runs could be continued");
    expect(byLabel(view.container, "Send steering message")).toBeNull();
    expect(byLabel(view.container, "Resume the agent run")).toBeNull();
    view.unmount();
  });

  it("continues a settled run from the composer", async () => {
    store.record = record({
      status: "completed",
      endedAt: 3000,
      spec: { mode: "editing", toolNames: ["read_file"] },
    });
    const view = mount(<AgentRunView runId="run-1" />);
    const field = textarea(view.container);

    expect(field.disabled).toBe(false);
    expect(field.placeholder).toBe("Continue the agent…");
    await act(async () => {
      typeInto(field, "also check the tests");
    });
    await act(async () => {
      byLabel(view.container, "Continue the agent run")?.click();
    });
    await flush();

    expect(session.continueAgentRun).toHaveBeenCalledWith("run-1", "also check the tests");
    expect(session.steerAgentRun).not.toHaveBeenCalled();
    view.unmount();
  });

  it("resumes a stopped run and shows why a continuation was refused", async () => {
    session.continueAgentRun.mockResolvedValue({ status: "limit_exceeded", message: "At most 3 agents may run per conversation." });
    store.record = record({
      status: "stopped",
      stopReason: "user_stop",
      endedAt: 3000,
      spec: { mode: "editing", toolNames: ["read_file"] },
    });
    const view = mount(<AgentRunView runId="run-1" />);

    await act(async () => {
      byLabel(view.container, "Resume the agent run")?.click();
    });
    await flush();

    expect(session.continueAgentRun).toHaveBeenCalledWith("run-1", "Continue where you left off.");
    expect(view.container.textContent).toContain("At most 3 agents may run per conversation.");
    view.unmount();
  });

  it("shows the run's profile and how full its context is in the header", () => {
    store.record = record({ profile: "reviewer", contextTokens: 45_000, contextCap: 200_000 });
    const view = mount(<AgentRunView runId="run-1" />);

    expect(view.container.querySelector('[data-slot="agent-profile-chip"]')?.textContent).toBe("reviewer");
    expect(view.container.querySelector('[data-slot="agent-context-meter"]')?.textContent).toBe("ctx 45k / 200k");
    view.unmount();
  });

  it("hides the context meter until the run has measured its context", () => {
    store.record = record();
    const view = mount(<AgentRunView runId="run-1" />);

    expect(view.container.querySelector('[data-slot="agent-context-meter"]')).toBeNull();
    expect(view.container.querySelector('[data-slot="agent-profile-chip"]')).toBeNull();
    view.unmount();
  });

  it("returns to the conversation from the back action and from Escape", () => {
    store.record = record();
    const view = mount(<AgentRunView runId="run-1" />);

    act(() => {
      byLabel(view.container, "Back to conversation")?.click();
    });
    expect(useAgentPanelStore.getState().selectedRunId).toBeNull();

    useAgentPanelStore.getState().open("run-1");
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(useAgentPanelStore.getState().selectedRunId).toBeNull();
    view.unmount();
  });

  it("opens a run from a sub-agent report card", () => {
    useAgentPanelStore.getState().clear();
    const view = mount(<SubAgentReport report={{ runId: "run-9", status: "completed", response: "ok" }} />);

    act(() => {
      (view.container.querySelector('[data-slot="sub-agent-open-run"]') as HTMLButtonElement).click();
    });
    expect(useAgentPanelStore.getState().selectedRunId).toBe("run-9");
    view.unmount();
  });
});
