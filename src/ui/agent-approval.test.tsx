import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PendingAgentApproval } from "../agents/approval-queue";
import { AgentApprovalCard } from "./agent-approval";

function approval(input: unknown): PendingAgentApproval {
  return { id: "ap1", runId: "run-1", toolName: "call_user_tool", input, createdAt: 1 };
}

describe("AgentApprovalCard", () => {
  it("offers Allow and Deny only", () => {
    const markup = renderToStaticMarkup(
      <AgentApprovalCard approval={approval({ url: "https://example.com" })} />,
    );
    expect(markup).toContain("Allow");
    expect(markup).toContain("Deny");
    expect(markup).not.toContain("Always allow");
  });

  it("never renders a credential in the tool input", () => {
    const markup = renderToStaticMarkup(
      <AgentApprovalCard
        approval={approval({ headers: { Authorization: "Bearer supersecret" }, apiKey: "abc123" })}
      />,
    );
    expect(markup).toContain("[redacted]");
    expect(markup).not.toContain("supersecret");
    expect(markup).not.toContain("abc123");
  });
});
