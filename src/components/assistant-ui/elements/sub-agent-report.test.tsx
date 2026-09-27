import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SubAgentReport } from "./sub-agent-report.aui";

describe("SubAgentReport", () => {
  it("shows the agent, its status, the response, and the untrusted marker", () => {
    const html = renderToStaticMarkup(
      <SubAgentReport
        report={{
          runId: "run-7c21",
          label: "audit",
          status: "completed",
          response: "Four call sites, all in the vault layer.",
        }}
      />,
    );
    expect(html).toContain("Sub-agent: audit");
    expect(html).toContain("Completed");
    expect(html).toContain("Four call sites, all in the vault layer.");
    expect(html).toContain("untrusted output");
    expect(html).toContain("Open run");
    expect(html).toContain("run-7c21");
  });

  it("names a failure instead of dressing it as a success", () => {
    const html = renderToStaticMarkup(
      <SubAgentReport
        report={{ status: "limit_exceeded", response: "The agent hit its step budget." }}
      />,
    );
    expect(html).toContain("Sub-agent report");
    expect(html).toContain("Limit reached");
    expect(html).toContain("The agent hit its step budget.");
  });

  it("renders the response as markdown", () => {
    const html = renderToStaticMarkup(
      <SubAgentReport
        report={{ status: "completed", response: "## Summary\n\n- first\n- second" }}
      />,
    );
    expect(html).toContain("<h2");
    expect(html).toContain("Summary");
    expect(html).toContain("<li");
  });

  it("names a stopped run", () => {
    const html = renderToStaticMarkup(
      <SubAgentReport
        report={{ status: "stopped", response: "Stopped by the user.", stopReason: "user_stop" }}
      />,
    );
    expect(html).toContain("Stopped");
    expect(html).toContain("Stopped by the user.");
  });
});
