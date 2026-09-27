import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { activityOf, elapsed, isRunning, toolCallCount } from "./agent-status";

type Part = UIMessage["parts"][number];

function assistant(parts: unknown[]): UIMessage {
  return { id: "x", role: "assistant", parts: parts as Part[] };
}

function user(text: string): UIMessage {
  return { id: "u", role: "user", parts: [{ type: "text", text }] };
}

describe("elapsed", () => {
  it("reads seconds under a minute", () => {
    expect(elapsed(1_000, undefined, 4_500)).toBe("4s");
  });

  it("reads minutes and seconds once a run passes a minute", () => {
    expect(elapsed(0, undefined, 75_000)).toBe("1m 15s");
  });

  it("stops counting once the run has an end time", () => {
    expect(elapsed(0, 5_000, 60_000)).toBe("5s");
  });
});

describe("isRunning", () => {
  it("is true only for the running status", () => {
    expect(isRunning("running")).toBe(true);
    expect(isRunning("completed")).toBe(false);
    expect(isRunning("interrupted")).toBe(false);
  });
});

describe("activityOf", () => {
  it("names the tool a running run is currently inside, via the tool-view registry", () => {
    const messages = [
      user("map the repo"),
      assistant([
        { type: "tool-list_dir", toolCallId: "c1", state: "input-available", input: { path: "src" } },
      ]),
    ];
    expect(activityOf(messages, "running")).toBe("Listed src");
  });

  it("falls back to a humanized tool name for a tool with no tailored view", () => {
    const messages = [
      assistant([
        { type: "dynamic-tool", toolName: "custom_search", toolCallId: "c1", state: "input-streaming" },
      ]),
    ];
    expect(activityOf(messages, "running")).toBe("Custom search");
  });

  it("reads the last assistant text line when no tool is running", () => {
    const messages = [
      assistant([{ type: "text", text: "Scanning the workspace…\nFound 12 files." }]),
    ];
    expect(activityOf(messages, "running")).toBe("Found 12 files.");
  });

  it("ignores a settled tool part's state and reports the final assistant line", () => {
    const messages = [
      assistant([
        { type: "tool-list_dir", toolCallId: "c1", state: "input-available", input: { path: "src" } },
        { type: "text", text: "Stopped before finishing." },
      ]),
    ];
    expect(activityOf(messages, "interrupted")).toBe("Stopped before finishing.");
  });

  it("is empty when a settled run left no assistant text", () => {
    const messages = [user("map the repo")];
    expect(activityOf(messages, "completed")).toBe("");
  });
});

describe("toolCallCount", () => {
  it("counts tool parts on assistant messages and ignores user turns", () => {
    const messages = [
      user("go"),
      assistant([
        { type: "tool-list_dir", toolCallId: "c1", state: "output-available", input: {}, output: {} },
        { type: "text", text: "done" },
        { type: "dynamic-tool", toolName: "custom", toolCallId: "c2", state: "output-available", input: {}, output: {} },
      ]),
    ];
    expect(toolCallCount(messages)).toBe(2);
  });

  it("is zero for a run with no tool calls", () => {
    expect(toolCallCount([assistant([{ type: "text", text: "hi" }])])).toBe(0);
  });
});
