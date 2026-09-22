import {
  BadgeCheck,
  Library,
  ListTree,
  Pencil,
  Plus,
  Quote,
  Rows3,
  Search,
  Sparkles,
  Trash2,
} from "lucide-react";
import { RagCitations } from "../../rag-citations.aui";
import {
  ToolChip,
  ToolCode,
  ToolKeyValues,
  ToolSection,
  type ChipTone,
  type ToolDetailProps,
  type ToolViewSpec,
} from "../primitives";
import { asArray, asNumber, asRecord, asString, pluralize } from "../helpers";

const VERDICT_TONES: Record<string, ChipTone> = {
  verified: "positive",
  contradicted: "danger",
  unsupported: "caution",
  fabricated: "danger",
};

function RagPassageList({ passages }: { passages: Array<Record<string, unknown>> }) {
  return (
    <ul className="flex flex-col gap-1.5">
      {passages.map((passage, index) => (
        <li key={asString(passage.id) ?? index} className="flex flex-col gap-1">
          <div className="flex flex-wrap items-baseline gap-1.5">
            <span className="text-foreground/90 truncate text-xs font-medium">
              {asString(passage.docTitle) || "Untitled"}
            </span>
            {asNumber(passage.ordinal) !== undefined && (
              <span className="text-faint numeric font-mono text-[10px]">
                #{asNumber(passage.ordinal)}
              </span>
            )}
          </div>
          <p className="text-muted text-xs leading-relaxed">
            {asString(passage.text) ?? ""}
          </p>
        </li>
      ))}
    </ul>
  );
}

function chunkDetail({ envelope }: ToolDetailProps) {
  if (!envelope?.ok) return null;
  const value = asRecord(envelope.value);
  const text = asString(value.text);
  return (
    <div className="flex flex-col gap-2">
      <ToolKeyValues
        rows={[
          { key: "document", value: asString(value.docTitle) || "Untitled" },
          { key: "ordinal", value: String(asNumber(value.ordinal) ?? ""), mono: true },
          { key: "chunk id", value: asString(value.id) ?? "", mono: true },
        ]}
      />
      {text !== undefined && text.length > 0 && <ToolCode text={text} limit={200} />}
    </div>
  );
}

function neighborsDetail({ envelope }: ToolDetailProps) {
  if (!envelope?.ok) return null;
  const value = asRecord(envelope.value);
  const neighbors = asArray(value.neighbors).map(asRecord);
  return (
    <div className="flex flex-col gap-2">
      {value.injectionWithheld === true && (
        <ToolChip tone="caution">withheld: injected instruction</ToolChip>
      )}
      {neighbors.length === 0 ? (
        <p className="text-muted text-xs">No readable neighbouring passages.</p>
      ) : (
        <RagPassageList passages={neighbors} />
      )}
    </div>
  );
}

function verifyDetail({ envelope }: ToolDetailProps) {
  if (!envelope?.ok) return null;
  const value = asRecord(envelope.value);
  const verdict = asString(value.verdict) ?? "unsupported";
  const confidence = asNumber(value.confidence);
  const score = asNumber(value.score);
  const span = asString(value.span);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <ToolChip tone={VERDICT_TONES[verdict] ?? "neutral"}>{verdict}</ToolChip>
        {value.auto === true && <ToolChip tone="accent">auto-accepted</ToolChip>}
      </div>
      <ToolKeyValues
        rows={[
          { key: "document", value: asString(value.docTitle) || "Untitled" },
          { key: "chunk id", value: asString(value.chunkId) ?? "", mono: true },
          ...(confidence !== null && confidence !== undefined
            ? [{ key: "confidence", value: confidence.toFixed(2), mono: true }]
            : []),
          ...(score !== undefined ? [{ key: "score", value: score.toFixed(3), mono: true }] : []),
        ]}
      />
      {span !== undefined && span.length > 0 && (
        <ToolSection label="Matched span">
          <ToolCode text={span} limit={20} />
        </ToolSection>
      )}
    </div>
  );
}

function skillEntryDetail({ envelope }: ToolDetailProps) {
  if (!envelope?.ok) return null;
  const value = asRecord(envelope.value);
  const allowedTools = asArray(value.allowedTools).filter(
    (item): item is string => typeof item === "string",
  );
  const description = asString(value.description);
  const instructions = asString(value.instructions);
  const notice = asString(value.notice);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <ToolChip tone="accent">{asString(value.source) ?? "vault"}</ToolChip>
        <ToolChip tone={value.enabled === true ? "positive" : "neutral"}>
          {value.enabled === true ? "enabled" : "disabled"}
        </ToolChip>
        {asString(value.id) !== undefined && (
          <span className="text-faint font-mono text-[10px]">{asString(value.id)}</span>
        )}
      </div>
      {description !== undefined && description.length > 0 && (
        <p className="text-muted text-xs leading-relaxed">{description}</p>
      )}
      {allowedTools.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {allowedTools.map((name) => (
            <ToolChip key={name}>{name}</ToolChip>
          ))}
        </div>
      )}
      {notice !== undefined && notice.length > 0 && (
        <p className="text-caution text-[10px] leading-relaxed">{notice}</p>
      )}
      {instructions !== undefined && instructions.length > 0 && (
        <ToolSection label="Instructions">
          <ToolCode text={instructions} limit={120} />
        </ToolSection>
      )}
    </div>
  );
}

function skillListDetail({ envelope }: ToolDetailProps) {
  if (!envelope?.ok) return null;
  const value = asRecord(envelope.value);
  const skills = asArray(value.skills).map(asRecord);
  if (skills.length === 0) {
    return <p className="text-muted text-xs">No skills are registered.</p>;
  }
  return (
    <ul className="flex flex-col gap-2">
      {skills.map((skill, index) => (
        <li key={asString(skill.id) ?? index} className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-foreground/90 truncate text-xs font-medium">
              {asString(skill.name) ?? ""}
            </span>
            <ToolChip>{asString(skill.source) ?? "vault"}</ToolChip>
            <ToolChip tone={skill.enabled === true ? "positive" : "neutral"}>
              {skill.enabled === true ? "on" : "off"}
            </ToolChip>
          </div>
          {asString(skill.description) !== undefined && (
            <p className="text-muted text-xs leading-relaxed">
              {asString(skill.description)}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

export const knowledgeViews = {
  search_documents: {
    icon: Search,
    label: (args) => `Searched the library${asString(args.query) ? `: ${asString(args.query)}` : ""}`,
    meta: (_args, envelope) => {
      if (!envelope?.ok) return undefined;
      const value = asRecord(envelope.value);
      const count = asArray(value.passages).length;
      if (count > 0) return pluralize(count, "passage");
      return asString(value.reason) ?? undefined;
    },
    Detail: ({ envelope }) =>
      envelope?.ok ? <RagCitations result={envelope} /> : null,
  },
  list_documents: {
    icon: Library,
    label: () => "Document library",
    meta: (_args, envelope) =>
      envelope?.ok ? pluralize(asArray(asRecord(envelope.value).documents).length, "document") : undefined,
    Detail: ({ envelope }) => {
      if (!envelope?.ok) return null;
      const documents = asArray(asRecord(envelope.value).documents).map(asRecord);
      if (documents.length === 0) {
        return <p className="text-muted text-xs">The library has no documents yet.</p>;
      }
      return (
        <ul className="flex flex-col gap-2">
          {documents.map((document, index) => (
            <li key={asString(document.id) ?? index} className="flex flex-col gap-1 rounded-sm bg-paper-sunk/40 px-2 py-1.5">
              <span
                className="text-foreground/90 truncate text-xs font-medium"
                title={asString(document.title)}
              >
                {asString(document.title) || "Untitled"}
              </span>
              <div className="flex flex-wrap items-center gap-1.5">
                <ToolChip>{asString(document.kind) ?? "text"}</ToolChip>
                <span className="text-faint numeric font-mono text-[10px]">
                  {pluralize(asNumber(document.chunkCount) ?? 0, "chunk")}
                </span>
                {asNumber(document.dims) !== undefined && (
                  <span className="text-faint numeric font-mono text-[10px]">
                    {asNumber(document.dims)} dims
                  </span>
                )}
                {asString(document.id) !== undefined && (
                  <span
                    className="text-faint/80 ms-auto max-w-[9rem] shrink-0 truncate font-mono text-[10px]"
                    title={asString(document.id)}
                  >
                    {asString(document.id)}
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      );
    },
  },
  get_chunk: {
    icon: Quote,
    label: () => "Read a passage",
    meta: (_args, envelope) =>
      envelope?.ok ? asString(asRecord(envelope.value).docTitle) || undefined : undefined,
    Detail: chunkDetail,
  },
  get_neighbors: {
    icon: Rows3,
    label: () => "Read neighbouring passages",
    meta: (_args, envelope) =>
      envelope?.ok ? pluralize(asArray(asRecord(envelope.value).neighbors).length, "passage") : undefined,
    Detail: neighborsDetail,
  },
  verify_citation: {
    icon: BadgeCheck,
    label: () => "Verified a citation",
    meta: (_args, envelope) =>
      envelope?.ok ? asString(asRecord(envelope.value).verdict) : undefined,
    Detail: verifyDetail,
  },
  load_skill: {
    icon: Sparkles,
    label: (args, envelope) => {
      const name = envelope?.ok ? asString(asRecord(envelope.value).name) : undefined;
      return `Loaded skill ${name ?? asString(args.id) ?? ""}`.trim();
    },
    meta: (_args, envelope) =>
      envelope?.ok ? asString(asRecord(envelope.value).source) : undefined,
    Detail: skillEntryDetail,
  },
  search_skills: {
    icon: Search,
    label: () => "Searched skills",
    meta: (_args, envelope) => {
      if (!envelope?.ok) return undefined;
      const value = asRecord(envelope.value);
      return `${asNumber(value.matched) ?? 0} of ${asNumber(value.scanned) ?? 0}`;
    },
    Detail: ({ envelope }) => {
      if (!envelope?.ok) return null;
      const value = asRecord(envelope.value);
      const matches = asArray(value.matches).map(asRecord);
      if (matches.length === 0) {
        return <p className="text-muted text-xs">No skill matched the query.</p>;
      }
      return (
        <ul className="flex flex-col gap-1.5">
          {matches.map((match, index) => (
            <li key={asString(match.id) ?? index} className="flex flex-col gap-0.5">
              <div className="flex items-center gap-1.5">
                <span className="text-foreground/90 truncate text-xs font-medium">
                  {asString(match.name) ?? ""}
                </span>
                <ToolChip>{asString(match.source) ?? "vault"}</ToolChip>
              </div>
              {asString(match.description) !== undefined && (
                <p className="text-muted text-xs leading-relaxed">
                  {asString(match.description)}
                </p>
              )}
            </li>
          ))}
        </ul>
      );
    },
  },
  list_skills: {
    icon: ListTree,
    label: () => "Skills",
    meta: (_args, envelope) =>
      envelope?.ok ? pluralize(asArray(asRecord(envelope.value).skills).length, "skill") : undefined,
    Detail: skillListDetail,
  },
  create_skill: {
    icon: Plus,
    label: (args, envelope) => {
      const name = envelope?.ok ? asString(asRecord(envelope.value).name) : undefined;
      return `Created skill ${name ?? asString(args.name) ?? asString(args.id) ?? ""}`.trim();
    },
    meta: (_args, envelope) =>
      envelope?.ok ? asString(asRecord(envelope.value).source) : undefined,
    Detail: skillEntryDetail,
  },
  update_skill: {
    icon: Pencil,
    label: (args, envelope) => {
      const name = envelope?.ok ? asString(asRecord(envelope.value).name) : undefined;
      return `Updated skill ${name ?? asString(args.name) ?? asString(args.id) ?? ""}`.trim();
    },
    meta: (_args, envelope) =>
      envelope?.ok ? asString(asRecord(envelope.value).source) : undefined,
    Detail: skillEntryDetail,
  },
  delete_skill: {
    icon: Trash2,
    label: (args) => `Deleted skill ${asString(args.id) ?? ""}`.trim(),
    Detail: ({ envelope }) => {
      if (!envelope?.ok) return null;
      const value = asRecord(envelope.value);
      return (
        <ToolKeyValues
          rows={[
            { key: "id", value: asString(value.id) ?? "", mono: true },
            { key: "status", value: value.deleted === true ? "deleted" : "unchanged" },
          ]}
        />
      );
    },
  },
} satisfies Record<string, ToolViewSpec>;
