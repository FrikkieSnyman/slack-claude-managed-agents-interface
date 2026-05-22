import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { ThreadSessionStore } from "../../src/store/thread-session-store.js";
import { handleInboundMessage, deriveThreadKey, shouldHandleMessage } from "../../src/slack/gateway.js";
import type { CmaClient } from "../../src/cma/client.js";

interface FakeDaemon {
  attachToTurn: (ts: string) => void;
  sendUserMessage: (text: string) => Promise<void>;
}

function fakeClient(): CmaClient {
  return {
    createSession: vi.fn(async () => ({ id: "sesn_new", status: "idle" as const })),
    retrieveSession: vi.fn(async () => ({ id: "sesn_new", status: "idle" as const })),
    sendUserMessage: vi.fn(async () => {}),
    streamEvents: vi.fn(async () => ({
      async *[Symbol.asyncIterator]() {},
      close() {},
    })),
    listEvents: vi.fn(() => ({ async *[Symbol.asyncIterator]() {} })),
  };
}

describe("deriveThreadKey", () => {
  it("uses thread_ts when message is in a thread", () => {
    expect(
      deriveThreadKey({ team: "T", channel: "C", ts: "10.0", thread_ts: "5.0" }),
    ).toEqual({ teamId: "T", channelId: "C", threadTs: "5.0" });
  });

  it("falls back to message ts when not in a thread (channel message)", () => {
    expect(
      deriveThreadKey({ team: "T", channel: "C", ts: "10.0", channel_type: "channel" }),
    ).toEqual({ teamId: "T", channelId: "C", threadTs: "10.0" });
  });

  it("uses channel as thread key for top-level DM messages", () => {
    expect(
      deriveThreadKey({ team: "T", channel: "D1", ts: "10.0", channel_type: "im" }),
    ).toEqual({ teamId: "T", channelId: "D1", threadTs: "D1" });
  });

  it("uses thread_ts inside a threaded DM", () => {
    expect(
      deriveThreadKey({ team: "T", channel: "D1", ts: "10.0", thread_ts: "5.0", channel_type: "im" }),
    ).toEqual({ teamId: "T", channelId: "D1", threadTs: "5.0" });
  });
});

describe("shouldHandleMessage", () => {
  let store: ThreadSessionStore;
  beforeEach(() => {
    const db = new Database(":memory:");
    store = new ThreadSessionStore(db);
  });

  it("handles a plain DM", () => {
    expect(
      shouldHandleMessage(
        { team: "T", channel: "D1", ts: "10.0", channel_type: "im", text: "hi" },
        "BOT",
        store,
      ),
    ).toBe(true);
  });

  it("skips messages with any subtype", () => {
    expect(
      shouldHandleMessage(
        { team: "T", channel: "D1", ts: "10.0", channel_type: "im", text: "hi", subtype: "message_changed" },
        "BOT",
        store,
      ),
    ).toBe(false);
  });

  it("skips bot-authored messages", () => {
    expect(
      shouldHandleMessage(
        { team: "T", channel: "D1", ts: "10.0", channel_type: "im", text: "hi", bot_id: "B123" },
        "BOT",
        store,
      ),
    ).toBe(false);
  });

  it("skips messages containing the bot's own @mention (app_mention handles them)", () => {
    expect(
      shouldHandleMessage(
        { team: "T", channel: "C", ts: "10.0", channel_type: "channel", text: "<@BOT> hi", thread_ts: "5.0" },
        "BOT",
        store,
      ),
    ).toBe(false);
  });

  it("handles a channel thread reply when a session exists for that thread", () => {
    store.upsert({
      teamId: "T", channelId: "C", threadTs: "5.0",
      sessionId: "sesn_1", lastStatus: "idle",
    });
    expect(
      shouldHandleMessage(
        { team: "T", channel: "C", ts: "10.0", channel_type: "channel", text: "follow-up", thread_ts: "5.0" },
        "BOT",
        store,
      ),
    ).toBe(true);
  });

  it("skips a channel thread reply when no session exists for that thread", () => {
    expect(
      shouldHandleMessage(
        { team: "T", channel: "C", ts: "10.0", channel_type: "channel", text: "follow-up", thread_ts: "5.0" },
        "BOT",
        store,
      ),
    ).toBe(false);
  });

  it("skips a channel thread reply when the session is terminated", () => {
    store.upsert({
      teamId: "T", channelId: "C", threadTs: "5.0",
      sessionId: "sesn_dead", lastStatus: "terminated",
    });
    expect(
      shouldHandleMessage(
        { team: "T", channel: "C", ts: "10.0", channel_type: "channel", text: "follow-up", thread_ts: "5.0" },
        "BOT",
        store,
      ),
    ).toBe(false);
  });

  it("skips a top-level channel message (no thread_ts) — app_mention is the only channel entry", () => {
    expect(
      shouldHandleMessage(
        { team: "T", channel: "C", ts: "10.0", channel_type: "channel", text: "hello" },
        "BOT",
        store,
      ),
    ).toBe(false);
  });
});

describe("handleInboundMessage", () => {
  let store: ThreadSessionStore;
  beforeEach(() => {
    const db = new Database(":memory:");
    store = new ThreadSessionStore(db);
  });

  it("creates a session on miss, posts placeholder, sends user.message", async () => {
    const client = fakeClient();
    const daemons = new Map<string, FakeDaemon>();
    const getOrCreate = vi.fn((sessionId: string): FakeDaemon => {
      let d = daemons.get(sessionId);
      if (!d) {
        d = { attachToTurn: vi.fn(), sendUserMessage: vi.fn(async () => {}) };
        daemons.set(sessionId, d);
      }
      return d;
    });
    const postPlaceholder = vi.fn(async () => "placeholder-ts-1");

    await handleInboundMessage({
      key: { teamId: "T", channelId: "C", threadTs: "5.0" },
      text: "hello",
      store,
      client,
      getOrCreate: getOrCreate as unknown as (id: string) => FakeDaemon,
      postPlaceholder,
      cmaConfig: { agentId: "ag", environmentId: "env", vaultIds: [], memoryStoreId: null, githubRepo: null },
    });

    expect(client.createSession).toHaveBeenCalledTimes(1);
    expect(postPlaceholder).toHaveBeenCalledWith({ teamId: "T", channelId: "C", threadTs: "5.0" });
    const row = store.findByThread({ teamId: "T", channelId: "C", threadTs: "5.0" });
    expect(row?.sessionId).toBe("sesn_new");
    expect(row?.currentPlaceholderTs).toBe("placeholder-ts-1");

    const daemon = daemons.get("sesn_new")!;
    expect(daemon.attachToTurn).toHaveBeenCalledWith("placeholder-ts-1");
    expect(daemon.sendUserMessage).toHaveBeenCalledWith("hello");
  });

  it("serializes concurrent handleInboundMessage for the same thread — single createSession", async () => {
    const client = fakeClient();
    let daemonCount = 0;
    const daemons = new Map<string, FakeDaemon>();
    const getOrCreate = (sessionId: string): FakeDaemon => {
      let d = daemons.get(sessionId);
      if (!d) {
        d = { attachToTurn: vi.fn(), sendUserMessage: vi.fn(async () => {}) };
        daemons.set(sessionId, d);
        daemonCount++;
      }
      return d;
    };
    const postPlaceholder = vi.fn(async () => `ts-${Math.random()}`);

    const key = { teamId: "T", channelId: "C", threadTs: "5.0" };
    const args = {
      key,
      text: "concurrent",
      store,
      client,
      getOrCreate,
      postPlaceholder,
      cmaConfig: { agentId: "ag", environmentId: "env", vaultIds: [], memoryStoreId: null, githubRepo: null },
    };

    await Promise.all([
      handleInboundMessage(args),
      handleInboundMessage(args),
      handleInboundMessage(args),
    ]);

    expect(client.createSession).toHaveBeenCalledTimes(1);
    expect(daemonCount).toBe(1);
  });

  it("sets row status to running after sendUserMessage so restartAll picks it up", async () => {
    const client = fakeClient();
    const getOrCreate = vi.fn((sessionId: string): FakeDaemon => ({
      attachToTurn: vi.fn(),
      sendUserMessage: vi.fn(async () => {}),
    }));
    const postPlaceholder = vi.fn(async () => "ph-ts");

    await handleInboundMessage({
      key: { teamId: "T", channelId: "C", threadTs: "5.0" },
      text: "x",
      store,
      client,
      getOrCreate: getOrCreate as unknown as (id: string) => FakeDaemon,
      postPlaceholder,
      cmaConfig: { agentId: "ag", environmentId: "env", vaultIds: [], memoryStoreId: null, githubRepo: null },
    });

    expect(store.findByThread({ teamId: "T", channelId: "C", threadTs: "5.0" })?.lastStatus).toBe("running");
  });

  it("reuses existing session and posts a new placeholder per turn", async () => {
    store.upsert({
      teamId: "T", channelId: "C", threadTs: "5.0",
      sessionId: "sesn_old", lastStatus: "idle",
      currentPlaceholderTs: "old-ts",
    });
    const client = fakeClient();
    const daemons = new Map<string, FakeDaemon>();
    const getOrCreate = vi.fn((sessionId: string): FakeDaemon => {
      const d: FakeDaemon = { attachToTurn: vi.fn(), sendUserMessage: vi.fn(async () => {}) };
      daemons.set(sessionId, d);
      return d;
    });
    const postPlaceholder = vi.fn(async () => "new-placeholder-ts");

    await handleInboundMessage({
      key: { teamId: "T", channelId: "C", threadTs: "5.0" },
      text: "second turn",
      store,
      client,
      getOrCreate: getOrCreate as unknown as (id: string) => FakeDaemon,
      postPlaceholder,
      cmaConfig: { agentId: "ag", environmentId: "env", vaultIds: [], memoryStoreId: null, githubRepo: null },
    });

    expect(client.createSession).not.toHaveBeenCalled();
    expect(daemons.get("sesn_old")!.sendUserMessage).toHaveBeenCalledWith("second turn");
    expect(store.findByThread({ teamId: "T", channelId: "C", threadTs: "5.0" })?.currentPlaceholderTs).toBe(
      "new-placeholder-ts",
    );
  });
});
