import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SessionDaemon } from "../../src/cma/session-daemon.js";
import type { CmaClient, EventStream } from "../../src/cma/client.js";
import type { RenderableEvent } from "../../src/cma/event-types.js";

const um = (text: string) => ({ text, images: [] });

interface SlackUpdate { messageTs: string; text: string }
interface SlackPost { text: string }

function makeSlackWriter() {
  const updates: SlackUpdate[] = [];
  const posts: SlackPost[] = [];
  return {
    updates,
    posts,
    updatePlaceholder: vi.fn(async (messageTs: string, text: string) => {
      updates.push({ messageTs, text });
    }),
    postFinal: vi.fn(async (text: string): Promise<string> => {
      posts.push({ text });
      return `final-${posts.length}`;
    }),
    postError: vi.fn(async (text: string): Promise<string> => {
      posts.push({ text });
      return `err-${posts.length}`;
    }),
  };
}

function makeFakeStream(events: RenderableEvent[]): EventStream {
  let i = 0;
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (i >= events.length) return { value: undefined, done: true };
          return { value: events[i++]!, done: false };
        },
      };
    },
    close() {},
  };
}

function makeFakeClient(streamEvents: RenderableEvent[]): CmaClient {
  return {
    createSession: vi.fn(async () => ({ id: "sesn_x", status: "idle" as const, archived: false })),
    retrieveSession: vi.fn(async () => ({ id: "sesn_x", status: "running" as const, archived: false })),
    sendUserMessage: vi.fn(async () => {}),
    streamEvents: vi.fn(async () => makeFakeStream(streamEvents)),
    listEvents: vi.fn(() => ({ async *[Symbol.asyncIterator]() {} })),
  };
}

describe("SessionDaemon", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("runs a happy-path turn: tool use → result → message → idle", async () => {
    const events: RenderableEvent[] = [
      { type: "session.status_running" },
      { type: "agent.tool_use", id: "ev1", name: "bash", input: { command: "ls -la" } },
      { type: "agent.tool_result", tool_use_id: "ev1" },
      { type: "agent.message", content: [{ type: "text", text: "Done. Here is the listing." }] },
      { type: "session.status_idle" },
    ];
    const client = makeFakeClient(events);
    const slack = makeSlackWriter();
    const onStatus = vi.fn();

    const daemon = new SessionDaemon({
      sessionId: "sesn_x",
      client,
      slack,
      onStatusChange: onStatus,
      coalesceMs: 50,
    });

    daemon.attachToTurn("ts_placeholder_1");
    await daemon.sendUserMessage(um("hi"));
    await vi.advanceTimersByTimeAsync(500);
    await daemon.waitForIdle();

    expect(client.sendUserMessage).toHaveBeenCalledWith("sesn_x", um("hi"));
    expect(slack.updates.length).toBeGreaterThanOrEqual(1);
    const lastUpdate = slack.updates.at(-1)!;
    expect(lastUpdate.messageTs).toBe("ts_placeholder_1");
    expect(lastUpdate.text).toContain("Done");
    expect(slack.postFinal).toHaveBeenCalledTimes(1);
    expect(slack.posts[0]!.text).toBe("Done. Here is the listing.");
    expect(onStatus).toHaveBeenCalledWith("idle");
  });

  it("posts terminated error to thread on session.status_terminated", async () => {
    const events: RenderableEvent[] = [
      { type: "session.status_running" },
      { type: "session.error", error: { message: "container crashed" } },
      { type: "session.status_terminated" },
    ];
    const client = makeFakeClient(events);
    const slack = makeSlackWriter();
    const onStatus = vi.fn();

    const daemon = new SessionDaemon({
      sessionId: "sesn_x",
      client,
      slack,
      onStatusChange: onStatus,
      coalesceMs: 50,
    });

    daemon.attachToTurn("ts_placeholder_1");
    await daemon.sendUserMessage(um("hi"));
    await vi.advanceTimersByTimeAsync(500);
    await daemon.waitForTerminal();

    expect(slack.postError).toHaveBeenCalledTimes(1);
    expect(slack.postError.mock.calls[0]![0]).toContain("ended unexpectedly");
    expect(onStatus).toHaveBeenCalledWith("terminated");
    expect(slack.updates.at(-1)!.text).toContain("Session terminated");
  });

  it("resets log buffer and switches placeholder when steered mid-turn", async () => {
    const events: RenderableEvent[] = [
      { type: "session.status_running" },
      { type: "agent.tool_use", id: "ev1", name: "bash", input: { command: "step-A" } },
    ];
    const client = makeFakeClient(events);
    const slack = makeSlackWriter();

    const daemon = new SessionDaemon({
      sessionId: "sesn_x",
      client,
      slack,
      onStatusChange: vi.fn(),
      coalesceMs: 50,
      reconnect: false,
    });

    daemon.attachToTurn("ts_turn_1");
    await daemon.sendUserMessage(um("first"));
    await vi.advanceTimersByTimeAsync(200);

    daemon.attachToTurn("ts_turn_2");
    await daemon.sendUserMessage(um("second"));
    await vi.advanceTimersByTimeAsync(200);

    const ts1Updates = slack.updates.filter((u) => u.messageTs === "ts_turn_1");
    const ts2Updates = slack.updates.filter((u) => u.messageTs === "ts_turn_2");
    expect(ts1Updates.at(-1)!.text).toContain("Steered by new message");
    expect(ts2Updates.length).toBeGreaterThan(0);
  });

  it("isIdle reflects last known status", async () => {
    const events: RenderableEvent[] = [
      { type: "session.status_running" },
      { type: "session.status_idle" },
    ];
    const client = makeFakeClient(events);
    const slack = makeSlackWriter();

    const daemon = new SessionDaemon({
      sessionId: "sesn_x",
      client,
      slack,
      onStatusChange: vi.fn(),
      coalesceMs: 50,
    });

    daemon.attachToTurn("ts1");
    await daemon.sendUserMessage(um("hi"));
    await vi.advanceTimersByTimeAsync(500);
    await daemon.waitForIdle();

    expect(daemon.isIdle()).toBe(true);
  });

  it("clears streamLoop when stream ends without a terminal status, allowing next turn to spawn a fresh stream", async () => {
    // Stream that ends without idle / terminated
    const events: RenderableEvent[] = [
      { type: "session.status_running" },
      { type: "agent.tool_use", id: "ev1", name: "bash", input: { command: "ls" } },
    ];
    const client = makeFakeClient(events);
    const slack = makeSlackWriter();

    const daemon = new SessionDaemon({
      sessionId: "sesn_x",
      client,
      slack,
      onStatusChange: vi.fn(),
      coalesceMs: 50,
      reconnect: false,
    });

    daemon.attachToTurn("ts_1");
    await daemon.sendUserMessage(um("first"));
    await vi.advanceTimersByTimeAsync(500);

    // Wait until streamEvents was called once and runStream has time to exit naturally
    await vi.advanceTimersByTimeAsync(500);

    daemon.attachToTurn("ts_2");
    await daemon.sendUserMessage(um("second"));
    await vi.advanceTimersByTimeAsync(500);

    // streamEvents should have been invoked again for the second turn
    expect(client.streamEvents).toHaveBeenCalledTimes(2);
  });

  it("does not end the turn when a non-status event (e.g. session.error) arrives before status_running", async () => {
    // Regression: the initial lastStatus is "idle"; an early non-status event
    // must NOT be treated as end-of-turn. The turn ends only on status_idle.
    const events: RenderableEvent[] = [
      { type: "session.error", error: { message: "MCP server init failed" } },
      { type: "session.status_running" },
      { type: "agent.tool_use", id: "ev1", name: "bash", input: { command: "ls" } },
      { type: "agent.tool_result", tool_use_id: "ev1" },
      { type: "agent.message", content: [{ type: "text", text: "All finished." }] },
      { type: "session.status_idle" },
    ];
    const client = makeFakeClient(events);
    const slack = makeSlackWriter();

    const daemon = new SessionDaemon({
      sessionId: "sesn_x",
      client,
      slack,
      onStatusChange: vi.fn(),
      coalesceMs: 50,
    });

    daemon.attachToTurn("ts_1");
    await daemon.sendUserMessage(um("hi"));
    await vi.advanceTimersByTimeAsync(500);
    await daemon.waitForIdle();

    expect(slack.postFinal).toHaveBeenCalledTimes(1);
    expect(slack.posts[0]!.text).toBe("All finished.");
  });

  it("completes the turn when the stream ends early but the session is actually idle", async () => {
    // Stream ends before delivering status_idle; retrieveSession reports idle.
    const events: RenderableEvent[] = [
      { type: "session.status_running" },
      { type: "agent.message", content: [{ type: "text", text: "Quick answer." }] },
    ];
    const client: CmaClient = {
      ...makeFakeClient(events),
      retrieveSession: vi.fn(async () => ({ id: "sesn_x", status: "idle" as const, archived: false })),
    };
    const slack = makeSlackWriter();
    const onStatus = vi.fn();

    const daemon = new SessionDaemon({
      sessionId: "sesn_x",
      client,
      slack,
      onStatusChange: onStatus,
      coalesceMs: 50,
      reconnectDelayMs: 10,
    });

    daemon.attachToTurn("ts_1");
    await daemon.sendUserMessage(um("hi"));
    await vi.advanceTimersByTimeAsync(500);
    await daemon.waitForIdle();

    expect(client.retrieveSession).toHaveBeenCalled();
    expect(slack.postFinal).toHaveBeenCalledTimes(1);
    expect(slack.posts[0]!.text).toBe("Quick answer.");
    expect(onStatus).toHaveBeenCalledWith("idle");
  });

  it("reconnects when the stream ends mid-run and finishes on a later stream", async () => {
    // First stream ends after status_running (still running server-side);
    // retrieveSession says running, so the daemon re-attaches and the second
    // stream delivers the message + idle.
    const streams: RenderableEvent[][] = [
      [{ type: "session.status_running" }],
      [
        { type: "agent.message", content: [{ type: "text", text: "Done after reconnect." }] },
        { type: "session.status_idle" },
      ],
    ];
    let call = 0;
    const client: CmaClient = {
      createSession: vi.fn(async () => ({ id: "sesn_x", status: "idle" as const, archived: false })),
      retrieveSession: vi.fn(async () => ({ id: "sesn_x", status: "running" as const, archived: false })),
      sendUserMessage: vi.fn(async () => {}),
      streamEvents: vi.fn(async () => makeFakeStream(streams[Math.min(call++, streams.length - 1)]!)),
      listEvents: vi.fn(() => ({ async *[Symbol.asyncIterator]() {} })),
    };
    const slack = makeSlackWriter();

    const daemon = new SessionDaemon({
      sessionId: "sesn_x",
      client,
      slack,
      onStatusChange: vi.fn(),
      coalesceMs: 50,
      reconnectDelayMs: 10,
    });

    daemon.attachToTurn("ts_1");
    await daemon.sendUserMessage(um("hi"));
    await vi.advanceTimersByTimeAsync(500);
    await daemon.waitForIdle();

    expect(client.streamEvents).toHaveBeenCalledTimes(2);
    expect(slack.postFinal).toHaveBeenCalledTimes(1);
    expect(slack.posts[0]!.text).toBe("Done after reconnect.");
  });
});
