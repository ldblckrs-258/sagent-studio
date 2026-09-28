import { Brain } from "lucide-react";
import {
  ToolChip,
  ToolKeyValues,
  ToolSection,
  type ToolDetailProps,
  type ToolViewSpec,
} from "../primitives";
import { asArray, asRecord, asString, pluralize } from "../helpers";

function memoryOf(
  args: Record<string, unknown>,
  envelope: ToolDetailProps["envelope"],
): Record<string, unknown> {
  return envelope?.ok ? asRecord(asRecord(envelope.value).memory) : args;
}

function titleOf(args: Record<string, unknown>, envelope: ToolDetailProps["envelope"]): string {
  return asString(memoryOf(args, envelope).title) ?? asString(args.title) ?? "";
}

function memoryChips(args: Record<string, unknown>, envelope: ToolDetailProps["envelope"]) {
  const memory = memoryOf(args, envelope);
  const scope = asString(memory.scope) ?? asString(args.scope);
  return (
    <>
      {scope !== undefined && <ToolChip>{scope}</ToolChip>}
      {memory.important === true && <ToolChip tone="accent">important</ToolChip>}
    </>
  );
}

function MemoryBody({ memory }: { memory: Record<string, unknown> }) {
  const body = asString(memory.body);
  const scope = asString(memory.scope);
  const id = asString(memory.id);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-foreground/90 truncate text-xs font-medium">
          {asString(memory.title) ?? ""}
        </span>
        {scope !== undefined && <ToolChip>{scope}</ToolChip>}
        {memory.important === true && <ToolChip tone="accent">important</ToolChip>}
        {id !== undefined && <span className="text-faint font-mono text-[10px]">{id}</span>}
      </div>
      {body !== undefined && body.length > 0 && (
        <p className="text-muted whitespace-pre-wrap text-xs leading-relaxed">{body}</p>
      )}
    </div>
  );
}

function memoryDetail({ args, envelope }: ToolDetailProps) {
  if (!envelope?.ok) return null;
  return <MemoryBody memory={memoryOf(args, envelope)} />;
}

export const memoryViews = {
  remember: {
    icon: Brain,
    label: (args, envelope) => `Remembered «${titleOf(args, envelope)}»`,
    chips: memoryChips,
    Detail: memoryDetail,
  },
  update_memory: {
    icon: Brain,
    label: (args, envelope) => {
      const title = titleOf(args, envelope);
      return title ? `Updated memory «${title}»` : `Updated memory ${asString(args.id) ?? ""}`.trim();
    },
    chips: memoryChips,
    Detail: memoryDetail,
  },
  forget: {
    icon: Brain,
    label: (args) => `Forgot memory ${asString(args.id) ?? ""}`.trim(),
    Detail: ({ args, envelope }) => {
      if (!envelope?.ok) return null;
      return (
        <ToolKeyValues rows={[{ key: "id", value: asString(args.id) ?? "", mono: true }]} />
      );
    },
  },
  recall_memory: {
    icon: Brain,
    label: (_args, envelope) =>
      envelope?.ok
        ? `Recalled ${pluralize(asArray(asRecord(envelope.value).memories).length, "memory", "memories")}`
        : "Recall memories",
    meta: (args) => asString(args.query),
    Detail: ({ envelope }) => {
      if (!envelope?.ok) return null;
      const value = asRecord(envelope.value);
      const memories = asArray(value.memories).map(asRecord);
      const missing = asArray(value.missing)
        .map(asString)
        .filter((id): id is string => id !== undefined);
      return (
        <div className="flex flex-col gap-3">
          {memories.length === 0 ? (
            <p className="text-muted text-xs">No matching memories.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {memories.map((memory, index) => (
                <li key={asString(memory.id) ?? index}>
                  <MemoryBody memory={memory} />
                </li>
              ))}
            </ul>
          )}
          {missing.length > 0 && (
            <ToolSection label="Missing">
              <p className="text-faint font-mono text-[10px]">{missing.join(", ")}</p>
            </ToolSection>
          )}
        </div>
      );
    },
  },
} satisfies Record<string, ToolViewSpec>;
