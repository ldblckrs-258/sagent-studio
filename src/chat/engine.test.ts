import type { LanguageModel, UIMessage } from "ai";
import { jsonSchema, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillStore } from "../skills/registry";
import { SkillRegistry } from "../skills/registry";
import { ToolRegistry } from "../tools/registry";
import type { ToolProvider } from "../tools/types";
import type { Settings } from "../vault/settings";
import { defaultSettings } from "../vault/settings";
import { useVaultStore } from "../vault/store";
import type { EngineDeps } from "./engine";
import { createEngine } from "./engine";
import { abortersCount, useChatStore } from "./store";
import type { ChatThread } from "./types";
import { defaultThreadConfig } from "./types";

type Usage = {
  inputTokens: {
    total: number | undefined;
    noCache: number | undefined;
    cacheRead: number | undefined;
    cacheWrite: number | undefined;
  };
  outputTokens: {
    total: number | undefined;
    text: number | undefined;
    reasoning: number | undefined;
  };
};

type FinishReason = { unified: "stop" | "tool-calls"; raw: string | undefined };

type Chunk =
  | { type: "stream-start"; warnings: never[] }
  | { type: "text-start"; id: string }
  | { type: "text-delta"; id: string; delta: string }
  | { type: "text-end"; id: string }
  | { type: "tool-input-start"; id: string; toolName: string }
  | { type: "tool-input-delta"; id: string; delta: string }
  | { type: "tool-input-end"; id: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: string }
  | { type: "finish"; usage: Usage; finishReason: FinishReason };

function usage(): Usage {
  return {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
}

function streamOf(chunks: Chunk[]): ReadableStream<Chunk> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function textStep(id: string, delta: string): Chunk[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id },
    { type: "text-delta", id, delta },
    { type: "text-end", id },
    {
      type: "finish",
      usage: usage(),
      finishReason: { unified: "stop", raw: undefined },
    },
  ];
}

function toolStep(id: string, toolName: string, input: string): Chunk[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "tool-input-start", id, toolName },
    { type: "tool-input-delta", id, delta: input },
    { type: "tool-input-end", id },
    { type: "tool-call", toolCallId: id, toolName, input },
    {
      type: "finish",
      usage: usage(),
      finishReason: { unified: "tool-calls", raw: "tool_calls" },
    },
  ];
}

function makeModel(
  entries: Array<{ stream: ReadableStream<Chunk> }>,
): MockLanguageModelV4 {
  return new MockLanguageModelV4({ doStream: entries });
}

function user(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

function assistant(id: string, text: string): UIMessage {
  return { id, role: "assistant", parts: [{ type: "text", text }] };
}

function textOf(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => (part as { text: string }).text)
    .join("");
}

const skillStore: SkillStore = {
  save: async () => {},
  remove: async () => {},
  list: async () => [],
};

function echoProvider(): ToolProvider {
  return {
    names: ["test_tool"],
    isAvailable: () => true,
    create: () =>
      tool({
        description: "Echo a value.",
        inputSchema: jsonSchema<{ value: string }>({
          type: "object",
          properties: { value: { type: "string" } },
        }),
        execute: async (input) =>
          `echo:${String((input as { value?: unknown }).value ?? "")}`,
      }),
  };
}

function slowProvider(): ToolProvider {
  return {
    names: ["slow_tool"],
    isAvailable: () => true,
    create: () =>
      tool({
        description: "Never resolves until aborted.",
        inputSchema: jsonSchema({ type: "object" }),
        execute: (_input, options) =>
          new Promise((_resolve, reject) => {
            const signal = (options as { abortSignal?: AbortSignal })
              .abortSignal;
            const abort = () =>
              reject(new DOMException("aborted", "AbortError"));
            if (signal?.aborted) abort();
            else signal?.addEventListener("abort", abort);
          }),
      }),
  };
}

interface MemoryStore {
  loadThread(id: string): Promise<ChatThread | null>;
  saveThread(thread: ChatThread): Promise<void>;
  listThreads(): Promise<
    Array<{
      id: string;
      title: string;
      workspaceName?: string;
      updatedAt: number;
    }>
  >;
  deleteThread(id: string): Promise<void>;
  get(id: string): ChatThread | undefined;
}

function memoryStore(initial: ChatThread[] = []): MemoryStore {
  const threads = new Map(initial.map((thread) => [thread.id, thread]));
  return {
    loadThread: async (id) => threads.get(id) ?? null,
    saveThread: async (thread) => {
      threads.set(thread.id, thread);
    },
    listThreads: async () =>
      [...threads.values()].map((thread) => ({
        id: thread.id,
        title: thread.title,
        updatedAt: thread.updatedAt,
      })),
    deleteThread: async (id) => {
      threads.delete(id);
    },
    get: (id) => threads.get(id),
  };
}

function setup(options: {
  model: LanguageModel;
  toolRegistry?: ToolRegistry;
  skillRegistry?: SkillRegistry;
  settings?: Settings | null;
  store?: MemoryStore;
  modelFactory?: EngineDeps["modelFactory"];
}) {
  const store = options.store ?? memoryStore();
  const toolRegistry = options.toolRegistry ?? new ToolRegistry();
  const skillRegistry = options.skillRegistry ?? new SkillRegistry(skillStore);
  const deps: EngineDeps = {
    getSettings: () =>
      options.settings === undefined ? defaultSettings() : options.settings,
    skillRegistry,
    toolRegistry,
    threadStore: store,
    modelFactory: options.modelFactory ?? (() => options.model),
  };
  return { engine: createEngine(deps), store, toolRegistry, skillRegistry };
}

function seed(
  id: string,
  messages: UIMessage[],
  config = defaultThreadConfig("p1", "m1"),
): ChatThread {
  const thread: ChatThread = {
    id,
    title: "Thread",
    messages,
    config,
    createdAt: 1,
    updatedAt: 1,
  };
  useChatStore.getState().setThread(thread);
  return thread;
}

function toolNamesOf(model: MockLanguageModelV4, call: number): string[] {
  const tools = model.doStreamCalls[call]?.tools ?? [];
  return tools.map((entry) => (entry as { name?: string }).name ?? "");
}

describe("chat engine", () => {
  beforeEach(() => {
    useChatStore.getState().clear();
  });

  it("streams a text turn and persists it", async () => {
    const model = makeModel([{ stream: streamOf(textStep("t1", "Hello")) }]);
    const { engine, store } = setup({ model });
    seed("th1", []);

    await engine.sendTurn("th1", "hi");

    const messages = useChatStore.getState().threads.th1.messages;
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(textOf(messages[1])).toBe("Hello");
    expect(messages[1].metadata).toMatchObject({ chatStatus: "done" });
    expect(store.get("th1")?.messages).toHaveLength(2);
  });

  it("forwards the system instruction and model parameters", async () => {
    const config = {
      ...defaultThreadConfig("p1", "m1"),
      systemInstruction: "SYSTEM_MARKER",
      params: { temperature: 0.5, topP: 0.9, maxOutputTokens: 123 },
    };
    const model = makeModel([{ stream: streamOf(textStep("t1", "done")) }]);
    const { engine } = setup({ model });
    seed("th1", [], config);

    await engine.sendTurn("th1", "go");

    expect(model.doStreamCalls).toHaveLength(1);
    expect(model.doStreamCalls[0].temperature).toBe(0.5);
    expect(model.doStreamCalls[0].topP).toBe(0.9);
    expect(model.doStreamCalls[0].maxOutputTokens).toBe(123);
    expect(JSON.stringify(model.doStreamCalls[0].prompt)).toContain(
      "SYSTEM_MARKER",
    );
  });

  it("keeps running tool steps until the model stops calling tools", async () => {
    const registry = new ToolRegistry();
    registry.registerProvider(echoProvider());
    const toolSteps = Array.from({ length: 12 }, (_value, index) => ({
      stream: streamOf(
        toolStep(`c${index}`, "test_tool", `{"value":"${index}"}`),
      ),
    }));
    const model = makeModel([
      ...toolSteps,
      { stream: streamOf(textStep("t13", "finished")) },
    ]);
    const { engine } = setup({ model, toolRegistry: registry });
    seed("th1", []);

    await engine.sendTurn("th1", "go");

    expect(model.doStreamCalls).toHaveLength(13);
    const messages = useChatStore.getState().threads.th1.messages;
    expect(textOf(messages[1])).toBe("finished");
    expect(messages[1].metadata).toMatchObject({ chatStatus: "done" });
  });

  it("injects an enabled skill into the prompt and runs a tool step then a text step", async () => {
    const skillRegistry = new SkillRegistry(skillStore);
    skillRegistry.register(
      {
        id: "s1",
        name: "Skill One",
        description: "",
        instructions: "SKILL_MARKER",
        allowedTools: ["test_tool"],
        source: "vault",
      },
      { enabled: true },
    );
    const config = {
      ...defaultThreadConfig("p1", "m1"),
      enabledSkills: [{ id: "s1", source: "vault" as const }],
    };
    const registry = new ToolRegistry();
    registry.registerProvider(echoProvider());
    const model = makeModel([
      { stream: streamOf(toolStep("c1", "test_tool", '{"value":"x"}')) },
      { stream: streamOf(textStep("t2", "done")) },
    ]);
    const { engine } = setup({ model, toolRegistry: registry, skillRegistry });
    seed("th1", [], config);

    await engine.sendTurn("th1", "go");

    expect(model.doStreamCalls).toHaveLength(2);
    expect(JSON.stringify(model.doStreamCalls[0].prompt)).toContain(
      "SKILL_MARKER",
    );
    expect(toolNamesOf(model, 0)).toContain("test_tool");
    const messages = useChatStore.getState().threads.th1.messages;
    const last = messages[messages.length - 1];
    expect(last.parts.some((part) => part.type.startsWith("tool-"))).toBe(true);
  });

  it("passes the model id and provider options through", async () => {
    const config = {
      ...defaultThreadConfig("p1", "MODEL_X"),
      providerOptions: { openai: { foo: "bar" } },
    };
    const model = makeModel([{ stream: streamOf(textStep("t1", "ok")) }]);
    const seen: Array<{ providerId: string; modelId?: string }> = [];
    const { engine } = setup({
      model,
      modelFactory: (_settings, providerId, modelId) => {
        seen.push({ providerId, modelId });
        return model;
      },
    });
    seed("th1", [], config);

    await engine.sendTurn("th1", "go");

    expect(seen).toEqual([{ providerId: "p1", modelId: "MODEL_X" }]);
    expect(model.doStreamCalls[0].providerOptions).toMatchObject({
      openai: { foo: "bar" },
    });
  });

  it("drops the assistant placeholder when the stream fails to build", async () => {
    const model = makeModel([{ stream: streamOf(textStep("t1", "never")) }]);
    const { engine, store } = setup({
      model,
      modelFactory: () => {
        throw new Error("bad provider config");
      },
    });
    seed("th1", []);

    await engine.sendTurn("th1", "hi");

    expect(
      useChatStore
        .getState()
        .threads.th1.messages.map((message) => message.role),
    ).toEqual(["user"]);
    expect(store.get("th1")?.messages.map((message) => message.role)).toEqual([
      "user",
    ]);
    expect(useChatStore.getState().error).toContain("bad provider config");
  });

  it("removes a skill prompt block when the skill is not enabled", async () => {
    const skillRegistry = new SkillRegistry(skillStore);
    skillRegistry.register(
      {
        id: "s1",
        name: "Skill One",
        description: "",
        instructions: "SKILL_MARKER",
        allowedTools: ["test_tool"],
        source: "vault",
      },
      { enabled: false },
    );
    const config = {
      ...defaultThreadConfig("p1", "m1"),
      enabledSkills: [{ id: "s1", source: "vault" as const }],
    };
    const registry = new ToolRegistry();
    registry.registerProvider(echoProvider());
    const model = makeModel([{ stream: streamOf(textStep("t1", "ok")) }]);
    const { engine } = setup({ model, toolRegistry: registry, skillRegistry });
    seed("th1", [], config);

    await engine.sendTurn("th1", "go");

    expect(JSON.stringify(model.doStreamCalls[0].prompt)).not.toContain(
      "SKILL_MARKER",
    );
  });

  it("edits a user message, truncates downstream, and reruns", async () => {
    const model = makeModel([
      { stream: streamOf(textStep("t1", "regenerated")) },
    ]);
    const { engine } = setup({ model });
    seed("th1", [
      user("u1", "old"),
      assistant("a1", "old answer"),
      user("u2", "later"),
      assistant("a2", "later answer"),
    ]);

    await engine.editMessage("th1", "u1", [{ type: "text", text: "edited" }]);

    const messages = useChatStore.getState().threads.th1.messages;
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(textOf(messages[0])).toBe("edited");
    expect(textOf(messages[1])).toBe("regenerated");
    expect(model.doStreamCalls).toHaveLength(1);
  });

  it("edits an assistant message without rerunning", async () => {
    const model = makeModel([]);
    const { engine } = setup({ model });
    seed("th1", [user("u1", "q"), assistant("a1", "old")]);

    await engine.editMessage("th1", "a1", [
      { type: "text", text: "edited answer" },
    ]);

    expect(textOf(useChatStore.getState().threads.th1.messages[1])).toBe(
      "edited answer",
    );
    expect(model.doStreamCalls).toHaveLength(0);
  });

  it("reruns a middle assistant message from its own parent without duplication", async () => {
    const model = makeModel([
      { stream: streamOf(textStep("t1", "regenerated")) },
    ]);
    const { engine, store } = setup({ model });
    seed("th1", [
      user("u1", "q1"),
      assistant("a1", "answer1"),
      user("u2", "q2"),
      assistant("a2", "answer2"),
    ]);

    await engine.rerun("th1", "a1");

    const messages = useChatStore.getState().threads.th1.messages;
    expect(messages).toHaveLength(2);
    expect(messages[0].id).toBe("u1");
    expect(textOf(messages[1])).toBe("regenerated");
    expect(store.get("th1")?.messages).toHaveLength(2);
  });

  it("undoes the last turn", async () => {
    const model = makeModel([]);
    const { engine } = setup({ model });
    seed("th1", [user("u1", "q"), assistant("a1", "a")]);

    await engine.undo("th1");

    expect(useChatStore.getState().threads.th1.messages).toHaveLength(0);
  });

  it("cancels a tool-loop run and sanitizes the persisted assistant message", async () => {
    const registry = new ToolRegistry();
    registry.registerProvider(slowProvider());
    const model = makeModel([
      { stream: streamOf(toolStep("c1", "slow_tool", "{}")) },
    ]);
    const { engine, store } = setup({ model, toolRegistry: registry });
    seed("th1", []);

    const run = engine.sendTurn("th1", "go");
    await vi.waitFor(() => expect(model.doStreamCalls.length).toBe(1));
    await engine.cancel("th1");
    await run;

    const assistantMessage = useChatStore
      .getState()
      .threads.th1.messages.at(-1);
    if (!assistantMessage) throw new Error("missing assistant message");
    const toolPart = assistantMessage.parts.find((part) =>
      part.type.startsWith("tool-"),
    ) as Record<string, unknown> | undefined;
    expect(toolPart?.state).toBe("output-error");
    expect(assistantMessage.metadata).toMatchObject({ chatStatus: "done" });
    expect(store.get("th1")?.messages.at(-1)?.metadata).toMatchObject({
      chatStatus: "done",
    });
  });

  it("rehydrates a poisoned persisted thread so the next request converts", async () => {
    const poisoned: ChatThread = {
      id: "th1",
      title: "Thread",
      messages: [
        user("u1", "q"),
        {
          id: "a1",
          role: "assistant",
          parts: [
            {
              type: "tool-call",
              toolCallId: "c1",
              state: "input-available",
              input: {},
            } as unknown as UIMessage["parts"][number],
          ],
          metadata: { chatStatus: "streaming" },
        },
      ],
      config: defaultThreadConfig("p1", "m1"),
      createdAt: 1,
      updatedAt: 1,
    };
    const model = makeModel([{ stream: streamOf(textStep("t2", "ok")) }]);
    const { engine } = setup({ model, store: memoryStore([poisoned]) });

    await engine.sendTurn("th1", "again");

    const messages = useChatStore.getState().threads.th1.messages;
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(textOf(messages[3])).toBe("ok");
  });

  it("dispose unregisters its abort callback and aborts an in-flight run", async () => {
    const registry = new ToolRegistry();
    registry.registerProvider(slowProvider());
    const model = makeModel([
      { stream: streamOf(toolStep("c1", "slow_tool", "{}")) },
    ]);
    const { engine } = setup({ model, toolRegistry: registry });
    seed("th1", []);
    useVaultStore.setState({ status: "unlocked" });

    const registered = abortersCount();
    const run = engine.sendTurn("th1", "go");
    await vi.waitFor(() => expect(model.doStreamCalls.length).toBe(1));

    engine.dispose();
    await run;

    expect(abortersCount()).toBe(registered - 1);
    expect(useChatStore.getState().activeRuns).toBe(0);
    expect(useChatStore.getState().status).toBe("idle");
  });

  it("keeps streaming when one of two concurrent runs ends", async () => {
    const registry = new ToolRegistry();
    registry.registerProvider(slowProvider());
    const model = makeModel([
      { stream: streamOf(toolStep("c1", "slow_tool", "{}")) },
      { stream: streamOf(toolStep("c2", "slow_tool", "{}")) },
    ]);
    const { engine } = setup({ model, toolRegistry: registry });
    seed("th1", []);
    seed("th2", []);

    const first = engine.sendTurn("th1", "go");
    await vi.waitFor(() => expect(model.doStreamCalls.length).toBe(1));
    const second = engine.sendTurn("th2", "go");
    await vi.waitFor(() => expect(model.doStreamCalls.length).toBe(2));
    expect(useChatStore.getState().activeRuns).toBe(2);

    await engine.cancel("th1");
    await first;
    // th2 is still running: status must not flip to idle.
    expect(useChatStore.getState().activeRuns).toBe(1);
    expect(useChatStore.getState().status).toBe("streaming");

    await engine.cancel("th2");
    await second;
    expect(useChatStore.getState().activeRuns).toBe(0);
    expect(useChatStore.getState().status).toBe("idle");
  });

  it("aborts and clears on vault lock without an unhandled rejection", async () => {
    const registry = new ToolRegistry();
    registry.registerProvider(slowProvider());
    const model = makeModel([
      { stream: streamOf(toolStep("c1", "slow_tool", "{}")) },
    ]);
    const { engine } = setup({ model, toolRegistry: registry });
    seed("th1", []);
    useVaultStore.setState({ status: "unlocked" });

    const run = engine.sendTurn("th1", "go");
    await vi.waitFor(() => expect(model.doStreamCalls.length).toBe(1));
    useVaultStore.setState({ status: "locked" });
    await run;

    expect(useChatStore.getState().threads).toEqual({});
    expect(useChatStore.getState().status).toBe("idle");
  });
});
