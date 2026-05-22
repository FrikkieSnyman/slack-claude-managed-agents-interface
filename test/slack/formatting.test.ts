import { describe, it, expect } from "vitest";
import { LogBuffer, renderLogBuffer } from "../../src/slack/formatting.js";

describe("LogBuffer", () => {
  it("appends entries", () => {
    const buf = new LogBuffer();
    buf.append("event-1", "bash", "ls -la");
    expect(buf.entries).toEqual([
      { id: "event-1", tool: "bash", input: "ls -la", done: false },
    ]);
  });

  it("marks done by id", () => {
    const buf = new LogBuffer();
    buf.append("event-1", "bash", "ls -la");
    buf.markDone("event-1");
    expect(buf.entries[0]?.done).toBe(true);
  });

  it("markDone on unknown id is no-op", () => {
    const buf = new LogBuffer();
    expect(() => buf.markDone("nope")).not.toThrow();
  });

  it("reset clears entries", () => {
    const buf = new LogBuffer();
    buf.append("e1", "bash", "ls");
    buf.reset();
    expect(buf.entries).toEqual([]);
  });
});

describe("renderLogBuffer", () => {
  it("renders empty buffer as the working header", () => {
    const buf = new LogBuffer();
    expect(renderLogBuffer(buf, "running")).toBe("⏳ Working on it…");
  });

  it("renders entries with check / gear emoji", () => {
    const buf = new LogBuffer();
    buf.append("e1", "bash", "ls -la");
    buf.markDone("e1");
    buf.append("e2", "str_replace_editor", "create report.md");
    const out = renderLogBuffer(buf, "running");
    expect(out).toContain("✅ `bash`: ls -la");
    expect(out).toContain("⚙️ `str_replace_editor`: create report.md");
  });

  it("truncates very long input strings", () => {
    const buf = new LogBuffer();
    const longInput = "x".repeat(500);
    buf.append("e1", "bash", longInput);
    const out = renderLogBuffer(buf, "running");
    expect(out).toContain("…");
    expect(out.length).toBeLessThan(longInput.length + 100);
  });

  it("renders rescheduling header", () => {
    const buf = new LogBuffer();
    expect(renderLogBuffer(buf, "rescheduling")).toContain("Retrying");
  });

  it("collapses log into summary when status is idle", () => {
    const buf = new LogBuffer();
    buf.append("e1", "bash", "ls"); buf.markDone("e1");
    buf.append("e2", "bash", "cat"); buf.markDone("e2");
    expect(renderLogBuffer(buf, "idle")).toBe("✅ Done in 2 steps");
  });

  it("collapses single-step idle correctly", () => {
    const buf = new LogBuffer();
    buf.append("e1", "bash", "ls"); buf.markDone("e1");
    expect(renderLogBuffer(buf, "idle")).toBe("✅ Done in 1 step");
  });

  it("renders steered tail when steered=true", () => {
    const buf = new LogBuffer();
    buf.append("e1", "bash", "ls"); buf.markDone("e1");
    const out = renderLogBuffer(buf, "steered");
    expect(out).toContain("↪ Steered by new message");
  });

  it("caps total output below Slack's 3000-char block limit", () => {
    const buf = new LogBuffer();
    for (let i = 0; i < 200; i++) {
      buf.append(`e${i}`, "bash", `command number ${i}`);
      buf.markDone(`e${i}`);
    }
    const out = renderLogBuffer(buf, "running");
    expect(out.length).toBeLessThan(3000);
    expect(out).toContain("…earlier steps omitted…");
  });
});
