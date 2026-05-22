import { describe, it, expect } from "vitest";
import {
  isToolUseEvent,
  isToolResultEvent,
  isAgentMessageEvent,
  isStatusEvent,
  isErrorEvent,
  toolNameOf,
  toolInputPreviewOf,
  agentTextOf,
} from "../../src/cma/event-types.js";

describe("event type predicates", () => {
  it("identifies tool_use", () => {
    expect(isToolUseEvent({ type: "agent.tool_use" })).toBe(true);
    expect(isToolUseEvent({ type: "agent.mcp_tool_use" })).toBe(true);
    expect(isToolUseEvent({ type: "agent.message" })).toBe(false);
  });

  it("identifies tool_result", () => {
    expect(isToolResultEvent({ type: "agent.tool_result" })).toBe(true);
    expect(isToolResultEvent({ type: "agent.mcp_tool_result" })).toBe(true);
  });

  it("identifies agent.message", () => {
    expect(isAgentMessageEvent({ type: "agent.message" })).toBe(true);
  });

  it("identifies all status events", () => {
    expect(isStatusEvent({ type: "session.status_idle" })).toBe(true);
    expect(isStatusEvent({ type: "session.status_running" })).toBe(true);
    expect(isStatusEvent({ type: "session.status_rescheduled" })).toBe(true);
    expect(isStatusEvent({ type: "session.status_terminated" })).toBe(true);
    expect(isStatusEvent({ type: "agent.message" })).toBe(false);
  });

  it("identifies session.error", () => {
    expect(isErrorEvent({ type: "session.error" })).toBe(true);
  });
});

describe("event accessors", () => {
  it("extracts tool name", () => {
    expect(toolNameOf({ type: "agent.tool_use", name: "bash" })).toBe("bash");
    expect(toolNameOf({ type: "agent.mcp_tool_use", server_name: "linear", name: "list_issues" }))
      .toBe("linear.list_issues");
  });

  it("falls back to (unknown) for missing name", () => {
    expect(toolNameOf({ type: "agent.tool_use" })).toBe("(unknown)");
  });

  it("renders tool input preview", () => {
    expect(toolInputPreviewOf({ type: "agent.tool_use", input: { command: "ls -la" } }))
      .toBe("ls -la");
    expect(toolInputPreviewOf({ type: "agent.tool_use", input: { path: "/tmp/x" } }))
      .toBe("/tmp/x");
    expect(toolInputPreviewOf({ type: "agent.tool_use", input: { other: "field" } }))
      .toBe('{"other":"field"}');
    expect(toolInputPreviewOf({ type: "agent.tool_use" })).toBe("");
  });

  it("extracts text from agent.message", () => {
    const event = {
      type: "agent.message",
      content: [
        { type: "text", text: "Hello " },
        { type: "text", text: "world" },
      ],
    };
    expect(agentTextOf(event)).toBe("Hello world");
  });

  it("ignores non-text blocks in agent.message", () => {
    const event = {
      type: "agent.message",
      content: [
        { type: "image", source: { data: "..." } },
        { type: "text", text: "hi" },
      ],
    };
    expect(agentTextOf(event)).toBe("hi");
  });
});
