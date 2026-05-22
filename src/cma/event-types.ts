export interface RenderableEvent {
  type: string;
  [key: string]: unknown;
}

export type StatusType =
  | "session.status_idle"
  | "session.status_running"
  | "session.status_rescheduled"
  | "session.status_terminated";

const STATUS_TYPES: ReadonlySet<string> = new Set([
  "session.status_idle",
  "session.status_running",
  "session.status_rescheduled",
  "session.status_terminated",
]);

export function isToolUseEvent(e: RenderableEvent): boolean {
  return e.type === "agent.tool_use" || e.type === "agent.mcp_tool_use";
}

export function isToolResultEvent(e: RenderableEvent): boolean {
  return e.type === "agent.tool_result" || e.type === "agent.mcp_tool_result";
}

export function isAgentMessageEvent(e: RenderableEvent): boolean {
  return e.type === "agent.message";
}

export function isStatusEvent(e: RenderableEvent): e is RenderableEvent & { type: StatusType } {
  return STATUS_TYPES.has(e.type);
}

export function isErrorEvent(e: RenderableEvent): boolean {
  return e.type === "session.error";
}

export function toolNameOf(e: RenderableEvent): string {
  if (e.type === "agent.mcp_tool_use") {
    const server = typeof e.server_name === "string" ? e.server_name : "mcp";
    const name = typeof e.name === "string" ? e.name : "(unknown)";
    return `${server}.${name}`;
  }
  return typeof e.name === "string" ? e.name : "(unknown)";
}

export function toolInputPreviewOf(e: RenderableEvent): string {
  const input = e.input;
  if (input == null) return "";
  if (typeof input === "string") return input;
  if (typeof input === "object") {
    const obj = input as Record<string, unknown>;
    for (const key of ["command", "path", "query", "url"]) {
      const v = obj[key];
      if (typeof v === "string") return v;
    }
    return JSON.stringify(obj);
  }
  return String(input);
}

interface TextBlock { type: "text"; text: string }

export function agentTextOf(e: RenderableEvent): string {
  const content = e.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is TextBlock =>
      typeof b === "object" &&
      b !== null &&
      (b as { type: unknown }).type === "text" &&
      typeof (b as { text: unknown }).text === "string"
    )
    .map((b) => b.text)
    .join("");
}

export function getEventId(e: RenderableEvent): string | null {
  return typeof e.id === "string" ? e.id : null;
}

export function getToolUseIdFromResult(e: RenderableEvent): string | null {
  if (typeof e.tool_use_id === "string") return e.tool_use_id;
  return null;
}
