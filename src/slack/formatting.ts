const MAX_INPUT_PREVIEW = 120;
const MAX_RENDER_CHARS = 2800;

export interface LogEntry {
  id: string;
  tool: string;
  input: string;
  done: boolean;
}

export class LogBuffer {
  private readonly _entries: LogEntry[] = [];

  get entries(): readonly LogEntry[] {
    return this._entries;
  }

  append(id: string, tool: string, input: string): void {
    this._entries.push({ id, tool, input, done: false });
  }

  markDone(id: string): void {
    const entry = this._entries.find((e) => e.id === id);
    if (entry) entry.done = true;
  }

  reset(): void {
    this._entries.length = 0;
  }
}

export type RenderStatus = "running" | "rescheduling" | "rescheduling_long" | "idle" | "steered" | "terminated";

export function renderLogBuffer(buf: LogBuffer, status: RenderStatus, errorMsg?: string): string {
  if (status === "idle") {
    const n = buf.entries.length;
    return n === 1 ? "✅ Done in 1 step" : `✅ Done in ${n} steps`;
  }
  if (status === "terminated") {
    return `❌ Session terminated${errorMsg ? `: ${errorMsg}` : ""}`;
  }

  const header =
    status === "rescheduling"
      ? "⏳ Retrying…"
      : status === "rescheduling_long"
        ? "⏳ Slow start, still trying…"
        : "⏳ Working on it…";

  if (buf.entries.length === 0) return header;

  const lines = buf.entries.map((e) => {
    const icon = e.done ? "✅" : "⚙️";
    const preview =
      e.input.length > MAX_INPUT_PREVIEW
        ? e.input.slice(0, MAX_INPUT_PREVIEW) + "…"
        : e.input;
    return `${icon} \`${e.tool}\`: ${preview}`;
  });

  if (status === "steered") {
    lines.push("↪ Steered by new message");
  }

  let body = lines.join("\n");
  if ((header + "\n" + body).length > MAX_RENDER_CHARS) {
    const tail: string[] = [];
    let size = 0;
    const omitNote = "_…earlier steps omitted…_";
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      if (size + line.length + 1 + header.length + omitNote.length + 2 > MAX_RENDER_CHARS) break;
      tail.unshift(line);
      size += line.length + 1;
    }
    body = `${omitNote}\n${tail.join("\n")}`;
  }

  return `${header}\n${body}`;
}
