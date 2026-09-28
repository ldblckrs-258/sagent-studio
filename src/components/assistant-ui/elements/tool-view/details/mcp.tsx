import { Plug } from "lucide-react";
import { ToolChip, ToolCode, ToolKeyValues, type ToolViewSpec } from "../primitives";
import { asArray, asRecord, asString, formatBytes, pluralize } from "../helpers";

function countResources(envelope: Parameters<ToolViewSpec["label"]>[1]): number {
  if (!envelope?.ok) return 0;
  return asArray(asRecord(envelope.value).servers).reduce<number>(
    (total, server) => total + asArray(asRecord(server).resources).length,
    0,
  );
}

export const mcpViews = {
  list_mcp_resources: {
    icon: Plug,
    label: (args) => {
      const server = asString(args.server);
      return server ? `Listed MCP resources on ${server}` : "Listed MCP resources";
    },
    meta: (_args, envelope) =>
      envelope?.ok ? pluralize(countResources(envelope), "resource") : undefined,
    Detail: ({ envelope }) => {
      if (!envelope?.ok) return null;
      const servers = asArray(asRecord(envelope.value).servers).map(asRecord);
      return (
        <div className="flex flex-col gap-2">
          {servers.map((server) => {
            const name = asString(server.server) ?? "";
            const resources = asArray(server.resources).map(asRecord);
            const templates = asArray(server.templates).map(asRecord);
            return (
              <div key={name} className="flex flex-col gap-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-foreground/90 text-xs font-medium">{name}</span>
                  {templates.length > 0 && (
                    <ToolChip>{pluralize(templates.length, "template")}</ToolChip>
                  )}
                  {server.truncated === true && <ToolChip tone="caution">truncated</ToolChip>}
                </div>
                <ToolKeyValues
                  rows={[
                    ...resources.map((resource) => ({
                      key: asString(resource.name) ?? "",
                      value: asString(resource.uri) ?? "",
                      mono: true,
                    })),
                    ...templates.map((template) => ({
                      key: asString(template.name) ?? "",
                      value: asString(template.uriTemplate) ?? "",
                      mono: true,
                    })),
                  ]}
                />
              </div>
            );
          })}
        </div>
      );
    },
  },
  read_mcp_resource: {
    icon: Plug,
    label: (args) => `Read ${asString(args.uri) ?? "MCP resource"}`,
    chips: (args) => {
      const server = asString(args.server);
      return server ? <ToolChip>{server}</ToolChip> : null;
    },
    meta: (_args, envelope) =>
      envelope?.ok
        ? pluralize(asArray(asRecord(envelope.value).contents).length, "part")
        : undefined,
    Detail: ({ envelope }) => {
      if (!envelope?.ok) return null;
      const contents = asArray(asRecord(envelope.value).contents).map(asRecord);
      return (
        <div className="flex flex-col gap-2">
          {contents.map((content, index) => {
            const text = asString(content.text);
            const uri = asString(content.uri) ?? "";
            const mimeType = asString(content.mimeType);
            return (
              <div key={`${uri}-${index}`} className="flex flex-col gap-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-muted truncate font-mono text-[10px]">{uri}</span>
                  {mimeType !== undefined && <ToolChip>{mimeType}</ToolChip>}
                </div>
                {text !== undefined ? (
                  <ToolCode text={text} />
                ) : (
                  <p className="text-muted text-xs">
                    Binary content, {formatBytes(typeof content.bytes === "number" ? content.bytes : undefined)}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      );
    },
  },
} satisfies Record<string, ToolViewSpec>;
