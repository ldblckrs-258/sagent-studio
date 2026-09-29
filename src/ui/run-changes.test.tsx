// @vitest-environment jsdom
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunFileChange } from "../workspace/journal";

const session = vi.hoisted(() => ({
  agentRunChanges: vi.fn(async (): Promise<{ changes: RunFileChange[]; expired: boolean }> => ({ changes: [], expired: false })),
  revertAgentRun: vi.fn(async (): Promise<unknown> => ({ reverted: [], conflicts: [], unrestorable: [] })),
  terminal: {
    sessions: vi.fn((): { owner: { runId?: string }; running: boolean }[] => []),
    killOwned: vi.fn(async (): Promise<string[]> => []),
  },
}));

vi.mock("../session/session-context", () => ({
  useSession: () => session,
}));

import { RunChanges } from "./run-changes";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const changes: RunFileChange[] = [
  {
    path: "src/a.ts",
    kind: "modified",
    before: "one\n",
    after: "two\n",
    partial: false,
    addedLines: 1,
    removedLines: 1,
    diff: "@@ -1,1 +1,1 @@\n- one\n+ two",
  },
  {
    path: "src/b.ts",
    kind: "created",
    before: null,
    after: "b\n",
    partial: false,
    addedLines: 1,
    removedLines: 0,
    diff: "@@ -1,0 +1,1 @@\n+ b",
  },
];

async function mount(node: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return {
    container,
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function button(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((entry) => entry.textContent?.includes(text));
}

beforeEach(() => {
  session.agentRunChanges.mockResolvedValue({ changes, expired: false });
  session.revertAgentRun.mockClear();
  session.terminal.sessions.mockReturnValue([]);
  session.terminal.killOwned.mockClear();
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("RunChanges", () => {
  it("stops the run's live commands before reverting its files", async () => {
    session.revertAgentRun.mockResolvedValue({ reverted: ["src/a.ts"], conflicts: [], unrestorable: [] });
    session.terminal.sessions.mockReturnValue([{ owner: { runId: "run-1" }, running: true }]);
    const view = await mount(<RunChanges runId="run-1" status="completed" />);
    await act(async () => {
      button(view.container, "Revert this run")?.click();
    });
    expect(view.container.textContent).toContain("and stop 1 running command");
    await act(async () => {
      button(view.container, "Confirm")?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(session.terminal.killOwned).toHaveBeenCalledWith({ runId: "run-1" });
    expect(session.revertAgentRun).toHaveBeenCalledWith("run-1");
    view.unmount();
  });

  it("lists each changed file with its line counts and diff", async () => {
    const view = await mount(<RunChanges runId="run-1" status="completed" />);

    const rows = view.container.querySelectorAll('[data-slot="run-change"]');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("src/a.ts");
    expect(rows[0].textContent).toContain("+1");
    expect(rows[0].textContent).toContain("−1");
    expect(rows[1].textContent).toContain("created");
    expect(view.container.textContent).toContain("2 files changed");
    view.unmount();
  });

  it("asks for confirmation before reverting, then reports what it skipped", async () => {
    session.revertAgentRun.mockResolvedValue({ reverted: ["src/b.ts"], conflicts: ["src/a.ts"], unrestorable: [] });
    const view = await mount(<RunChanges runId="run-1" status="completed" />);

    await act(async () => {
      button(view.container, "Revert this run")?.click();
    });
    expect(session.revertAgentRun).not.toHaveBeenCalled();
    expect(view.container.textContent).toContain("Revert 2 files?");

    await act(async () => {
      button(view.container, "Confirm")?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(session.revertAgentRun).toHaveBeenCalledWith("run-1");
    const summary = view.container.querySelector('[data-slot="run-revert-outcome"]');
    expect(summary?.textContent).toContain("Reverted 1 file.");
    expect(summary?.textContent).toContain("src/a.ts");
    expect(summary?.textContent).toContain("changed after this run");
    expect(button(view.container, "Revert this run")?.disabled).toBe(true);
    view.unmount();
  });

  it("refuses to revert a run whose history the journal has already dropped", async () => {
    session.agentRunChanges.mockResolvedValue({ changes, expired: true });
    const view = await mount(<RunChanges runId="run-1" status="completed" />);

    expect(button(view.container, "Revert this run")?.disabled).toBe(true);
    expect(view.container.textContent).toContain("can no longer be reverted safely");
    view.unmount();
  });

  it("keeps revert unavailable while the run is still going", async () => {
    const view = await mount(<RunChanges runId="run-1" status="running" />);
    expect(button(view.container, "Revert this run")?.disabled).toBe(true);
    view.unmount();
  });
});
