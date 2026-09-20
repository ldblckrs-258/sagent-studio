import { describe, expect, it } from "vitest";
import type { SlashEntry } from "../chat/slash";
import {
  completionFor,
  moveHighlight,
  suggestionsFor,
} from "./slash-suggestions-state";

function entry(
  id: string,
  kind: "command" | "skill",
  extra: Partial<SlashEntry> = {},
): SlashEntry {
  return {
    id,
    label: `/${id}`,
    description: `${id} does a thing`,
    kind,
    run: async () => {},
    ...extra,
  };
}

const ENTRIES: SlashEntry[] = [
  entry("compact", "command", { argumentHint: "[what to keep]" }),
  entry("alpha", "skill", { source: "vault", argumentHint: "[what to do]" }),
  entry("alpine", "skill", { source: "workspace", argumentHint: "[what to do]" }),
  entry("beta", "skill", { source: "vault" }),
];

describe("suggestionsFor", () => {
  it("offers nothing for plain text, so the popover never covers normal typing", () => {
    expect(suggestionsFor(ENTRIES, "hello")).toEqual([]);
    expect(suggestionsFor(ENTRIES, "use /compact later")).toEqual([]);
    expect(suggestionsFor(ENTRIES, "")).toEqual([]);
  });

  it("offers the whole list for a bare slash", () => {
    expect(suggestionsFor(ENTRIES, "/").map((item) => item.id)).toEqual([
      "compact",
      "alpha",
      "alpine",
      "beta",
    ]);
  });

  it("filters by prefix, case-insensitively", () => {
    expect(suggestionsFor(ENTRIES, "/alp").map((item) => item.id)).toEqual([
      "alpha",
      "alpine",
    ]);
    expect(suggestionsFor(ENTRIES, "/ALP").map((item) => item.id)).toEqual([
      "alpha",
      "alpine",
    ]);
  });

  it("closes once the name is settled and arguments have started", () => {
    expect(suggestionsFor(ENTRIES, "/compact ")).toEqual([]);
    expect(suggestionsFor(ENTRIES, "/compact keep the notes")).toEqual([]);
  });

  it("offers nothing for a name that matches no entry", () => {
    expect(suggestionsFor(ENTRIES, "/zzz")).toEqual([]);
  });
});

describe("moveHighlight", () => {
  it("steps through the list in both directions", () => {
    expect(moveHighlight({ highlight: 0, count: 3 }, 1)).toBe(1);
    expect(moveHighlight({ highlight: 1, count: 3 }, -1)).toBe(0);
  });

  it("wraps at both ends, so the list needs no mouse", () => {
    expect(moveHighlight({ highlight: 2, count: 3 }, 1)).toBe(0);
    expect(moveHighlight({ highlight: 0, count: 3 }, -1)).toBe(2);
  });

  it("stays at zero for an empty list", () => {
    expect(moveHighlight({ highlight: 0, count: 0 }, 1)).toBe(0);
  });
});

describe("completionFor", () => {
  it("leaves a trailing space when the entry takes arguments", () => {
    expect(completionFor(ENTRIES[0], "/com")).toBe("/compact ");
  });

  it("completes exactly when the entry takes none", () => {
    expect(completionFor(ENTRIES[3], "/be")).toBe("/beta");
  });

  it("keeps the arguments already typed", () => {
    expect(completionFor(ENTRIES[0], "/com keep the notes")).toBe(
      "/compact keep the notes",
    );
  });

  it("writes the source suffix that makes a duplicated id reachable", () => {
    const workspaceDual = entry("dual@workspace", "skill", {
      source: "workspace",
      argumentHint: "[what to do]",
    });
    expect(completionFor(workspaceDual, "/dual")).toBe("/dual@workspace ");
  });
});
