// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunRecord } from "../../agents/store";

/*
  The panel tests run in jsdom because selection, the composer, and force-stop
  are interactions, not markup. The repository's default node environment has
  no DOM to drive keys or clicks through.
*/

const store = vi.hoisted(() => ({ record: null as unknown }));

vi.mock("../../agents/store", () => ({
  agentRunStore: {
    get: () => store.record,
    list: () => (store.record ? [store.record] : []),
    pendingApprovals: () => [],
    subscribe: () => () => {},
    getVersion: () => 1,
  },
}));

const session = vi.hoisted(() => ({
  steerAgentRun: vi.fn(() => true),
  stopAgentRun: vi.fn(() => true),
}));

vi.mock("../../session/session-context", () => ({
  useSession: () => session,
}));

vi.mock("../agent-approval", () => ({
  AgentApprovalCard: () => null,
}));

import { AgentFlowView } from "./agent-flow-view";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function record(overrides: Partial<AgentRunRecord> = {}): AgentRunRecord {
  return {
    runId: "run-1",
    parentThreadId: "t1",
    label: "scout",
    mode: "god",
    tier: "high",
    status: "running",
    prompt: "map the repo",
    events: [
      { type: "text-delta", text: "scanning files" },
      { type: "tool-call", toolName: "read_file", toolCallId: "c1", input: { path: "a.txt" } },
      { type: "user-message", text: "focus on the tests" },
    ],
    text: "scanning files",
    toolCalls: 1,
    approvals: [],
    startedAt: 1000,
    ...overrides,
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

/** Types into the assistant-ui composer; it only records text while focused. */
function typeInto(element: HTMLTextAreaElement, value: string): void {
  element.focus();
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

function sendButton(container: HTMLElement): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === "Send",
  );
}

function textarea(container: HTMLElement): HTMLTextAreaElement {
  return container.querySelector("textarea") as HTMLTextAreaElement;
}

beforeEach(() => {
  store.record = null;
  session.steerAgentRun.mockClear();
  session.stopAgentRun.mockClear();
  session.steerAgentRun.mockReturnValue(true);
  session.stopAgentRun.mockReturnValue(true);
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("AgentFlowView", () => {
  it("renders the live flow with a tool call and a steering message", () => {
    store.record = record();
    const onBack = vi.fn();
    const view = mount(
      <AgentFlowView runId="run-1" persisted={[]} now={2000} onBack={onBack} />,
    );

    const text = view.container.textContent ?? "";
    expect(text).toContain("scout");
    expect(text).toContain("scanning files");
    expect(text).toContain("focus on the tests");
    // The tool call renders through the main thread's tool-view, not raw text.
    expect(view.container.querySelector('[data-slot="tool-view-label"]')).not.toBeNull();

    view.unmount();
  });

  it("enables the composer only while the run is running", () => {
    store.record = record({ status: "running" });
    const running = mount(
      <AgentFlowView runId="run-1" persisted={[]} now={2000} onBack={() => {}} />,
    );
    expect(running.container.querySelector("textarea")?.disabled).toBe(false);
    running.unmount();

    store.record = record({ status: "completed" });
    const settled = mount(
      <AgentFlowView runId="run-1" persisted={[]} now={2000} onBack={() => {}} />,
    );
    expect(settled.container.querySelector("textarea")?.disabled).toBe(true);
    settled.unmount();
  });

  it("sends a steering message through the session", async () => {
    store.record = record();
    const view = mount(
      <AgentFlowView runId="run-1" persisted={[]} now={2000} onBack={() => {}} />,
    );
    const field = textarea(view.container);
    expect(field.disabled).toBe(false);

    act(() => typeInto(field, "hold on"));
    await act(async () => {
      sendButton(view.container)?.click();
    });

    expect(session.steerAgentRun).toHaveBeenCalledWith("run-1", "hold on");
    expect(view.container.textContent).toContain("hold on");

    view.unmount();
  });

  it("drops an unreconciled optimistic steer once the run settles", async () => {
    store.record = record();
    const view = mount(
      <AgentFlowView runId="run-1" persisted={[]} now={2000} onBack={() => {}} />,
    );
    const field = textarea(view.container);
    act(() => typeInto(field, "orphan steer"));
    await act(async () => {
      sendButton(view.container)?.click();
    });
    // The store accepted the steer but no matching `user-message` event arrives.
    expect(view.container.textContent).toContain("orphan steer");

    store.record = record({ status: "completed" });
    view.rerender(<AgentFlowView runId="run-1" persisted={[]} now={2000} onBack={() => {}} />);
    expect(view.container.textContent).not.toContain("orphan steer");

    view.unmount();
  });

  it("sends on Enter and leaves Shift+Enter for a newline", async () => {
    store.record = record();
    const view = mount(
      <AgentFlowView runId="run-1" persisted={[]} now={2000} onBack={() => {}} />,
    );
    const field = textarea(view.container);

    act(() => {
      typeInto(field, "one");
      field.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }),
      );
    });
    expect(session.steerAgentRun).not.toHaveBeenCalled();

    await act(async () => {
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(session.steerAgentRun).toHaveBeenCalledWith("run-1", "one");

    view.unmount();
  });

  it("force-stops optimistically until the store reports the run stopped", () => {
    store.record = record();
    const view = mount(
      <AgentFlowView runId="run-1" persisted={[]} now={2000} onBack={() => {}} />,
    );
    const stop = view.container.querySelector('[aria-label="Force-stop agent run"]');
    expect(stop).not.toBeNull();

    act(() => {
      (stop as HTMLButtonElement).click();
    });

    expect(session.stopAgentRun).toHaveBeenCalledWith("run-1");
    expect(view.container.textContent).toContain("Stopping");

    store.record = record({ status: "stopped", stopReason: "user_stop" });
    view.rerender(<AgentFlowView runId="run-1" persisted={[]} now={2000} onBack={() => {}} />);
    expect(view.container.textContent).toContain("You stopped this run");

    view.unmount();
  });

  it("disables the composer with a reason once the run is settled", () => {
    store.record = record({ status: "completed" });
    const view = mount(
      <AgentFlowView runId="run-1" persisted={[]} now={2000} onBack={() => {}} />,
    );

    expect(view.container.querySelector("textarea")?.disabled).toBe(true);
    expect(view.container.textContent).toContain("This run finished");

    view.unmount();
  });

  it("reports a run that produced no output", () => {
    store.record = record({ status: "completed", events: [] });
    const view = mount(
      <AgentFlowView runId="run-1" persisted={[]} now={2000} onBack={() => {}} />,
    );

    expect(view.container.textContent).toContain("(no output)");

    view.unmount();
  });

  it("renders streamed text as one block, not one line per delta", () => {
    store.record = record({
      status: "completed",
      events: [
        { type: "text-delta", text: "Workspace " },
        { type: "text-delta", text: "Structural " },
        { type: "text-delta", text: "Summary" },
      ],
      text: "Workspace Structural Summary",
    });
    const view = mount(
      <AgentFlowView runId="run-1" persisted={[]} now={2000} onBack={() => {}} />,
    );

    const paragraphs = Array.from(view.container.querySelectorAll("p, h1, h2, h3"));
    const joined = paragraphs.map((node) => node.textContent).join(" ");
    expect(joined).toContain("Workspace Structural Summary");
    view.unmount();
  });

  it("shows a tool call's result summary in the live flow", () => {
    store.record = record({
      status: "completed",
      events: [
        { type: "tool-call", toolName: "list_dir", toolCallId: "c1", input: {} },
        {
          type: "tool-result",
          toolName: "list_dir",
          toolCallId: "c1",
          output: {
            ok: true,
            code: "ok",
            value: { entries: [{ path: "a.ts" }, { path: "b.ts" }] },
          },
        },
      ],
      text: "",
    });
    const view = mount(
      <AgentFlowView runId="run-1" persisted={[]} now={2000} onBack={() => {}} />,
    );

    expect(view.container.textContent).toContain("Listed the workspace root");
    expect(view.container.textContent).toContain("2 entries");
    view.unmount();
  });

  it("does not render an approval prompt for a completed tool call", () => {
    store.record = record({
      status: "completed",
      events: [
        { type: "tool-call", toolName: "list_dir", toolCallId: "c1", input: {} },
        { type: "tool-result", toolName: "list_dir", toolCallId: "c1" },
      ],
      text: "",
    });
    const view = mount(
      <AgentFlowView runId="run-1" persisted={[]} now={2000} onBack={() => {}} />,
    );

    const labels = Array.from(view.container.querySelectorAll("button")).map((button) =>
      button.textContent?.trim(),
    );
    expect(labels).not.toContain("Allow");
    expect(labels).not.toContain("Deny");
    view.unmount();
  });

  it("returns to the list through the back action", () => {
    store.record = record();
    const onBack = vi.fn();
    const view = mount(
      <AgentFlowView runId="run-1" persisted={[]} now={2000} onBack={onBack} />,
    );

    const back = view.container.querySelector('[aria-label="Back to agent list"]');
    act(() => {
      (back as HTMLButtonElement).click();
    });
    expect(onBack).toHaveBeenCalledTimes(1);

    view.unmount();
  });
});
