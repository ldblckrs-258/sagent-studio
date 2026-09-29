import { List, Skull, SquareTerminal, TerminalSquare, Type } from "lucide-react";
import {
  ToolChip,
  ToolCode,
  ToolKeyValues,
  type ToolDetailProps,
  type ToolViewSpec,
} from "../primitives";
import { asArray, asNumber, asRecord, asString, pluralize, type ToolEnvelope } from "../helpers";

function shortSession(value: unknown): string {
  const id = asString(value);
  return id ? id.slice(0, 8) : "?";
}

function exitChips(envelope: ToolEnvelope | null) {
  if (!envelope?.ok) return undefined;
  const value = asRecord(envelope.value);
  const exitCode = asNumber(value.exitCode);
  const timedOut = value.timedOut === true;
  if (exitCode === undefined && !timedOut) return undefined;
  return (
    <>
      {exitCode !== undefined && (
        <ToolChip tone={exitCode === 0 ? "positive" : "danger"}>exit {exitCode}</ToolChip>
      )}
      {timedOut && <ToolChip tone="caution">timed out</ToolChip>}
    </>
  );
}

function OutputDetail({ envelope }: ToolDetailProps) {
  if (!envelope?.ok) return null;
  const output = asString(asRecord(envelope.value).output) ?? "";
  return output.length > 0 ? (
    <ToolCode text={output} limit={300} />
  ) : (
    <p className="text-faint text-xs">No output.</p>
  );
}

function writeLabel(args: Record<string, unknown>): string {
  const input = asString(args.input);
  const keys = asArray(args.keys).filter((key): key is string => typeof key === "string");
  const parts = [input !== undefined ? JSON.stringify(input) : "", keys.join(" ")].filter(Boolean);
  return `Typed ${parts.join(" ") || "Enter"} into ${shortSession(args.session)}`;
}

export const terminalViews = {
  run_command: {
    icon: SquareTerminal,
    label: (args) => asString(args.command) ?? "Ran a command",
    chips: (_args, envelope) => exitChips(envelope),
    Detail: OutputDetail,
  },
  terminal_start: {
    icon: TerminalSquare,
    label: (args) => asString(args.command) ?? "Started a shell",
    chips: (_args, envelope) => exitChips(envelope),
    meta: (_args, envelope) =>
      envelope?.ok ? shortSession(asRecord(envelope.value).session) : undefined,
    Detail: OutputDetail,
  },
  terminal_write: {
    icon: Type,
    label: (args) => writeLabel(args),
    chips: (_args, envelope) => exitChips(envelope),
    Detail: OutputDetail,
  },
  terminal_read: {
    icon: SquareTerminal,
    label: (args) => `Read ${shortSession(args.session)}`,
    chips: (_args, envelope) => exitChips(envelope),
    Detail: OutputDetail,
  },
  terminal_kill: {
    icon: Skull,
    label: (args) => `Stopped ${shortSession(args.session)}`,
    chips: (_args, envelope) => exitChips(envelope),
  },
  terminal_list: {
    icon: List,
    label: () => "Listed terminal sessions",
    meta: (_args, envelope) =>
      envelope?.ok ? pluralize(asArray(asRecord(envelope.value).sessions).length, "session") : undefined,
    Detail: ({ envelope }) => {
      if (!envelope?.ok) return null;
      const sessions = asArray(asRecord(envelope.value).sessions).map(asRecord);
      if (sessions.length === 0) return <p className="text-faint text-xs">No sessions.</p>;
      return (
        <ToolKeyValues
          rows={sessions.map((session) => ({
            key: shortSession(session.session),
            value: `${asString(session.command) ?? "shell"} · ${session.running === true ? "running" : `exit ${asNumber(session.exitCode) ?? "?"}`}`,
            mono: true,
          }))}
        />
      );
    },
  },
} satisfies Record<string, ToolViewSpec>;
