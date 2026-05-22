import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { ThreadSessionStore } from "../../src/store/thread-session-store.js";
import { DaemonRegistry } from "../../src/registry/daemon-registry.js";
import type { CmaClient } from "../../src/cma/client.js";

function fakeClient(retrieve: (id: string) => Promise<{ id: string; status: "idle" | "running" | "terminated" }>): CmaClient {
  return {
    createSession: vi.fn(async () => ({ id: "sesn_new", status: "idle" as const })),
    retrieveSession: vi.fn(async (id: string) => retrieve(id)),
    sendUserMessage: vi.fn(async () => {}),
    streamEvents: vi.fn(async () => ({
      async *[Symbol.asyncIterator]() {},
      close() {},
    })),
    listEvents: vi.fn(() => ({ async *[Symbol.asyncIterator]() {} })),
  };
}

function makeSlackWriter() {
  return {
    updatePlaceholder: vi.fn(async () => {}),
    postFinal: vi.fn(async () => "ts"),
    postError: vi.fn(async () => "ts"),
  };
}

describe("DaemonRegistry", () => {
  let store: ThreadSessionStore;

  beforeEach(() => {
    const db = new Database(":memory:");
    store = new ThreadSessionStore(db);
  });

  it("getOrCreate returns the same daemon for the same session id", () => {
    const client = fakeClient(async () => ({ id: "sesn_x", status: "idle" }));
    const reg = new DaemonRegistry(client, store, () => makeSlackWriter());
    const a = reg.getOrCreate("sesn_x");
    const b = reg.getOrCreate("sesn_x");
    expect(a).toBe(b);
  });

  it("restartAll spawns daemons for running sessions and updates idle ones", async () => {
    store.upsert({
      teamId: "T", channelId: "C1", threadTs: "1.1",
      sessionId: "sesn_running", lastStatus: "running",
    });
    store.upsert({
      teamId: "T", channelId: "C2", threadTs: "1.2",
      sessionId: "sesn_idle", lastStatus: "running",
    });

    const client = fakeClient(async (id) => ({
      id,
      status: id === "sesn_running" ? "running" : "idle",
    }));
    const reg = new DaemonRegistry(client, store, () => makeSlackWriter());

    await reg.restartAll();

    expect(reg.has("sesn_running")).toBe(true);
    expect(reg.has("sesn_idle")).toBe(false);
    expect(store.findBySessionId("sesn_idle")?.lastStatus).toBe("idle");
  });

  it("restartAll posts terminated message for sessions CMA reports terminated", async () => {
    store.upsert({
      teamId: "T", channelId: "C1", threadTs: "1.1",
      sessionId: "sesn_dead", lastStatus: "running",
    });
    const slackWriters: ReturnType<typeof makeSlackWriter>[] = [];
    const client = fakeClient(async () => ({ id: "sesn_dead", status: "terminated" }));
    const reg = new DaemonRegistry(client, store, () => {
      const w = makeSlackWriter();
      slackWriters.push(w);
      return w;
    });

    await reg.restartAll();

    expect(slackWriters[0]!.postError).toHaveBeenCalledTimes(1);
    expect(store.findBySessionId("sesn_dead")?.lastStatus).toBe("terminated");
    expect(reg.has("sesn_dead")).toBe(false);
  });

  it("evictIfIdle removes daemons past idle TTL", async () => {
    const client = fakeClient(async () => ({ id: "sesn_x", status: "idle" }));
    const reg = new DaemonRegistry(client, store, () => makeSlackWriter(), { idleTtlMs: 100 });
    const daemon = reg.getOrCreate("sesn_x");
    (daemon as unknown as { lastActivityAt: () => number }).lastActivityAt = () => Date.now() - 200;
    reg.evictIfIdle("sesn_x");
    expect(reg.has("sesn_x")).toBe(false);
  });
});
