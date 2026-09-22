import { Pencil, Play, Plus, Trash2, Wrench } from "lucide-react";
import {
  ToolChip,
  ToolFailure,
  ToolKeyValues,
  ToolSection,
  ValueView,
  type ToolDetailProps,
  type ToolViewSpec,
} from "../primitives";
import { asArray, asRecord, asString, pluralize, readEnvelope } from "../helpers";

function toolEntryDetail({ envelope }: ToolDetailProps) {
  if (!envelope?.ok) return null;
  const value = asRecord(envelope.value);
  const note = asString(value.note);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <ToolChip tone="accent">{asString(value.kind) ?? "tool"}</ToolChip>
        <ToolChip tone={value.enabled === true ? "positive" : "neutral"}>
          {value.enabled === true ? "enabled" : "disabled"}
        </ToolChip>
        {asString(value.name) !== undefined && (
          <span className="text-faint font-mono text-[10px]">{asString(value.name)}</span>
        )}
      </div>
      {asString(value.description) !== undefined &&
        (asString(value.description) ?? "").length > 0 && (
          <p className="text-muted text-xs leading-relaxed">
            {asString(value.description)}
          </p>
        )}
      {asString(value.summary) !== undefined && (
        <ToolKeyValues rows={[{ key: "request", value: asString(value.summary) ?? "", mono: true }]} />
      )}
      {note !== undefined && note.length > 0 && (
        <p className="text-caution text-[10px] leading-relaxed">{note}</p>
      )}
    </div>
  );
}

function callUserToolDetail({ args, envelope }: ToolDetailProps) {
  const input = asRecord(args.input);
  const inputEntries = Object.entries(input);
  const nested = readEnvelope(envelope?.value);
  return (
    <div className="flex flex-col gap-3">
      {asString(args.name) !== undefined && (
        <ToolSection label="Target">
          <p className="text-foreground/90 font-mono text-xs">{asString(args.name)}</p>
        </ToolSection>
      )}
      {inputEntries.length > 0 && (
        <ToolSection label="Input">
          <ValueView value={input} depth={1} />
        </ToolSection>
      )}
      {nested !== null &&
        (nested.ok ? (
          <ToolSection label="Result">
            <ValueView value={nested.value} depth={1} />
          </ToolSection>
        ) : (
          <ToolFailure envelope={nested} />
        ))}
    </div>
  );
}

export const toolsAdminViews = {
  list_user_tools: {
    icon: Wrench,
    label: () => "Custom tools",
    meta: (_args, envelope) =>
      envelope?.ok ? pluralize(asArray(asRecord(envelope.value).tools).length, "tool") : undefined,
    Detail: ({ envelope }) => {
      if (!envelope?.ok) return null;
      const tools = asArray(asRecord(envelope.value).tools).map(asRecord);
      if (tools.length === 0) {
        return <p className="text-muted text-xs">No custom tools are defined.</p>;
      }
      return (
        <ul className="flex flex-col gap-2">
          {tools.map((tool, index) => (
            <li key={asString(tool.name) ?? index} className="flex flex-col gap-0.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-foreground/90 truncate text-xs font-medium">
                  {asString(tool.name) ?? ""}
                </span>
                <ToolChip>{asString(tool.kind) ?? "tool"}</ToolChip>
                <ToolChip tone={tool.enabled === true ? "positive" : "neutral"}>
                  {tool.enabled === true ? "on" : "off"}
                </ToolChip>
              </div>
              {asString(tool.summary) !== undefined && (
                <p className="text-faint truncate font-mono text-[10px]">
                  {asString(tool.summary)}
                </p>
              )}
            </li>
          ))}
        </ul>
      );
    },
  },
  create_tool: {
    icon: Plus,
    label: (args, envelope) => {
      const name = envelope?.ok ? asString(asRecord(envelope.value).name) : undefined;
      return `Created tool ${name ?? asString(args.name) ?? ""}`.trim();
    },
    meta: (_args, envelope) =>
      envelope?.ok ? asString(asRecord(envelope.value).kind) : undefined,
    Detail: toolEntryDetail,
  },
  update_tool: {
    icon: Pencil,
    label: (args, envelope) => {
      const name = envelope?.ok ? asString(asRecord(envelope.value).name) : undefined;
      return `Updated tool ${name ?? asString(args.name) ?? asString(args.from) ?? ""}`.trim();
    },
    meta: (_args, envelope) =>
      envelope?.ok ? asString(asRecord(envelope.value).kind) : undefined,
    Detail: toolEntryDetail,
  },
  delete_tool: {
    icon: Trash2,
    label: (args) => `Deleted tool ${asString(args.name) ?? ""}`.trim(),
    Detail: ({ envelope }) => {
      if (!envelope?.ok) return null;
      const value = asRecord(envelope.value);
      return (
        <ToolKeyValues
          rows={[
            { key: "name", value: asString(value.name) ?? "", mono: true },
            { key: "status", value: value.deleted === true ? "deleted" : "unchanged" },
          ]}
        />
      );
    },
  },
  call_user_tool: {
    icon: Play,
    label: (args) => `Called ${asString(args.name) ?? "a custom tool"}`,
    Detail: callUserToolDetail,
  },
} satisfies Record<string, ToolViewSpec>;
