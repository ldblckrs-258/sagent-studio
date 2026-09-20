import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SlashEntry } from "../chat/slash";
import { SlashSuggestionsList } from "./slash-suggestions";

/*
  Only the open list's markup is asserted here. The repository runs vitest with
  `environment: "node"`, so there is no DOM to drive keys or clicks through;
  highlight movement, completion text, and dismissal are covered as pure
  functions in `slash-suggestions-state.test.ts`.
*/

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

function render(matches: SlashEntry[], highlight = 0): string {
  return renderToStaticMarkup(
    <SlashSuggestionsList
      matches={matches}
      highlight={highlight}
      onSelect={() => {}}
      onHighlight={() => {}}
    />,
  );
}

describe("SlashSuggestionsList", () => {
  it("lists each entry with its name, hint, and description", () => {
    const markup = render([
      entry("compact", "command", { argumentHint: "[what to keep]" }),
      entry("alpha", "skill", { source: "vault" }),
    ]);
    expect(markup).toContain("/compact");
    expect(markup).toContain("[what to keep]");
    expect(markup).toContain("compact does a thing");
    expect(markup).toContain("/alpha");
  });

  it("tags a workspace skill and leaves a vault one untagged", () => {
    const markup = render([
      entry("trusted", "skill", { source: "vault" }),
      entry("untrusted", "skill", { source: "workspace" }),
    ]);
    expect(markup.match(/workspace/g)).toHaveLength(1);
  });

  it("marks the highlighted row for assistive technology", () => {
    const markup = render(
      [entry("compact", "command"), entry("alpha", "skill")],
      1,
    );
    const selected = markup.match(/aria-selected="true"/g);
    expect(selected).toHaveLength(1);
    expect(markup.indexOf('aria-selected="true"')).toBeGreaterThan(
      markup.indexOf("/compact"),
    );
  });

  it("renders a listbox, so the popover is announced as a choice", () => {
    const markup = render([entry("compact", "command")]);
    expect(markup).toContain('role="listbox"');
    expect(markup).toContain('role="option"');
  });

  it("renders nothing but the empty list when there are no matches", () => {
    expect(render([])).not.toContain('role="option"');
  });
});
