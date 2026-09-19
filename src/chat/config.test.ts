import { describe, expect, it } from "vitest";
import type { ConfigDraft } from "./config";
import {
  fieldKeyForMessage,
  threadConfigPatch,
  validateConfigDraft,
} from "./config";
import { ChatConfigError } from "./errors";

function draft(overrides: Partial<ConfigDraft> = {}): ConfigDraft {
  return {
    providerId: "p1",
    modelId: "m1",
    systemInstruction: "be brief",
    temperature: "0.5",
    topP: "0.9",
    topK: "40",
    maxOutputTokens: "1024",
    providerOptions: '{"openai":{"foo":"bar"}}',
    enabledSkills: [],
    ...overrides,
  };
}

describe("threadConfigPatch", () => {
  it("parses a full draft into a candidate config", () => {
    const candidate = threadConfigPatch(draft()) as Record<string, unknown>;
    expect(candidate).toMatchObject({
      providerId: "p1",
      modelId: "m1",
      params: { temperature: 0.5, topP: 0.9, topK: 40, maxOutputTokens: 1024 },
      providerOptions: { openai: { foo: "bar" } },
    });
  });

  it("omits blank optional fields", () => {
    const candidate = threadConfigPatch(
      draft({
        modelId: "",
        temperature: "",
        topP: "",
        topK: "",
        maxOutputTokens: "",
        providerOptions: "",
      }),
    ) as Record<string, unknown>;
    expect(candidate).not.toHaveProperty("modelId");
    expect(candidate).not.toHaveProperty("providerOptions");
    expect(candidate.params).toEqual({});
  });

  it("throws a providerOptions-field error for malformed JSON", () => {
    try {
      threadConfigPatch(draft({ providerOptions: "{not json" }));
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ChatConfigError);
      expect(fieldKeyForMessage((error as Error).message)).toBe(
        "providerOptions",
      );
    }
  });
});

describe("validateThreadConfig draft", () => {
  it("accepts a valid draft and returns the validated config", () => {
    const result = validateConfigDraft(threadConfigPatch(draft()));
    expect(result.errors).toEqual({});
    expect(result.config).toMatchObject({ providerId: "p1" });
  });

  it.each([
    ["providerId", draft({ providerId: "  " })],
    ["temperature", draft({ temperature: "3" })],
    ["topP", draft({ topP: "2" })],
    ["topK", draft({ topK: "0" })],
    ["maxOutputTokens", draft({ maxOutputTokens: "-5" })],
  ])("reports exactly one %s field error", (field, value) => {
    const result = validateConfigDraft(threadConfigPatch(value));
    expect(result.config).toBeUndefined();
    expect(Object.keys(result.errors)).toEqual([field]);
  });

  it("reports a finite-number error for a non-numeric temperature", () => {
    const result = validateConfigDraft(
      threadConfigPatch(draft({ temperature: "abc" })),
    );
    expect(result.errors.temperature).toContain("finite number");
  });

  it("reports a providerOptions error for an array", () => {
    const result = validateConfigDraft(
      threadConfigPatch(draft({ providerOptions: "[]" })),
    );
    expect(Object.keys(result.errors)).toEqual(["providerOptions"]);
  });

  it("accepts an empty providerOptions object", () => {
    const result = validateConfigDraft(
      threadConfigPatch(draft({ providerOptions: "{}" })),
    );
    expect(result.errors).toEqual({});
  });

  it("maps a non-object draft and a bad skill ref to _form", () => {
    expect(Object.keys(validateConfigDraft("nope").errors)).toEqual(["_form"]);
    const badSkill = validateConfigDraft(
      threadConfigPatch(
        draft({ enabledSkills: [{ id: "", source: "vault" }] }),
      ),
    );
    expect(Object.keys(badSkill.errors)).toEqual(["_form"]);
  });
});
