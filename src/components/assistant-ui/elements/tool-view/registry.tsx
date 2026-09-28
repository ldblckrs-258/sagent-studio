"use client";

import { useMemo, useState, type FC } from "react";
import type {
  ToolCallMessagePartComponent,
  ToolCallMessagePartProps,
} from "@assistant-ui/react";
import {
  offersInterruptAction,
  ToolFallback,
  ToolFallbackApproval,
  ToolFallbackContent,
  ToolFallbackRoot,
} from "../tool-fallback.aui";
import {
  GenericDetail,
  ToolFailure,
  ToolViewTrigger,
  type ToolDetailProps,
  type ToolViewSpec,
} from "./primitives";
import { isPlainRecord, readEnvelope } from "./helpers";
import { workspaceViews } from "./details/workspace";
import { runtimeViews } from "./details/runtime";
import { knowledgeViews } from "./details/knowledge";
import { toolsAdminViews } from "./details/tools-admin";
import { agentsViews } from "./details/agents";
import { memoryViews } from "./details/memory";
import { mcpViews } from "./details/mcp";

/**
 * Tailored transcript views for every built-in tool. Keyed by the tool name the
 * model calls; a name absent here falls through to the generic `ToolFallback`
 * (and any override the host passed), which is the correct default for a user's
 * own tools, whose argument shape is unknown at build time.
 *
 * Everything in this map is presentation only. A view reads `args` and `result`
 * and renders them; it never writes a message part, an artifact, or metadata,
 * so the model-visible content of a turn is unchanged by the UI.
 */
export const TOOL_VIEWS: Record<string, ToolViewSpec> = {
  ...workspaceViews,
  ...runtimeViews,
  ...knowledgeViews,
  ...toolsAdminViews,
  ...agentsViews,
  ...memoryViews,
  ...mcpViews,
};

export const toolViewNames: readonly string[] = Object.keys(TOOL_VIEWS);

type ToolCallViewProps = ToolCallMessagePartProps & {
  /** Rendered for a tool with no tailored view. Defaults to `ToolFallback`. */
  fallback?: ToolCallMessagePartComponent | undefined;
};

/**
 * Dispatches one tool-call part to its tailored view, or to the fallback for an
 * unregistered tool. This is the single entry point wired into the thread, so
 * adding a built-in tool view is a registry edit and nothing else.
 */
export const ToolCallView: FC<ToolCallViewProps> = ({ fallback, ...part }) => {
  const spec = TOOL_VIEWS[part.toolName];
  if (!spec) {
    const Fallback = fallback ?? ToolFallback;
    return <Fallback {...part} />;
  }
  return <SpecializedToolView spec={spec} {...part} />;
};

type SpecializedToolViewProps = ToolCallMessagePartProps & { spec: ToolViewSpec };

function SpecializedToolView({
  spec,
  args,
  status,
  result,
  addResult,
  resume,
  interrupt,
  approval,
  respondToApproval,
}: SpecializedToolViewProps) {
  const envelope = useMemo(() => readEnvelope(result), [result]);
  const record: Record<string, unknown> = isPlainRecord(args) ? args : {};

  const isCancelled = status?.type === "incomplete" && status.reason === "cancelled";
  const isFailed = status?.type === "incomplete" && !isCancelled;
  const isRequiresAction = status?.type === "requires-action";
  const shouldRenderApproval =
    isRequiresAction && offersInterruptAction(status, approval, interrupt);

  // A call that needs a decision, that failed, or whose view opens itself (a
  // preview the model wants seen) is shown without the user hunting for it. The
  // transition check catches a self-opening view whose result lands after the
  // first render, when `envelope` flips from null to a value.
  const autoOpen =
    isRequiresAction || isFailed || spec.autoOpen?.(record, envelope) === true;
  const [open, setOpen] = useState(autoOpen);
  const [prevAutoOpen, setPrevAutoOpen] = useState(autoOpen);
  if (autoOpen !== prevAutoOpen) {
    setPrevAutoOpen(autoOpen);
    if (autoOpen) setOpen(true);
  }

  const label = spec.label(record, envelope);
  const meta = spec.meta?.(record, envelope);
  const chips = spec.chips?.(record, envelope);
  const action = spec.action?.(record, envelope);
  const Detail = spec.Detail ?? GenericDetail;
  const detailProps: ToolDetailProps = { args: record, envelope, status };

  const trigger = (
    <ToolViewTrigger
      icon={spec.icon}
      label={label}
      meta={meta}
      {...(chips !== undefined ? { chips } : {})}
      status={status}
    />
  );

  return (
    <ToolFallbackRoot open={open} onOpenChange={setOpen}>
      {action !== undefined && action !== null ? (
        <div className="flex items-center gap-1">
          <div className="min-w-0 flex-1">{trigger}</div>
          {action}
        </div>
      ) : (
        trigger
      )}
      <ToolFallbackContent>
        <ToolFailure envelope={envelope} status={status} />
        {shouldRenderApproval && (
          <ToolFallbackApproval
            addResult={addResult}
            resume={resume}
            interrupt={interrupt}
            approval={approval}
            respondToApproval={respondToApproval}
            status={status}
          />
        )}
        {!isCancelled && <Detail {...detailProps} />}
      </ToolFallbackContent>
    </ToolFallbackRoot>
  );
}
