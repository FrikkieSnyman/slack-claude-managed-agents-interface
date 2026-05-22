import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { ThreadSessionStore, type ThreadKey } from "../../src/store/thread-session-store.js";

const key: ThreadKey = { teamId: "T1", channelId: "C1", threadTs: "1700000000.000100" };

describe("ThreadSessionStore", () => {
  let store: ThreadSessionStore;

  beforeEach(() => {
    const db = new Database(":memory:");
    store = new ThreadSessionStore(db);
  });

  it("returns null on miss", () => {
    expect(store.findByThread(key)).toBeNull();
  });

  it("upserts and finds by thread", () => {
    store.upsert({ ...key, sessionId: "sesn_1", lastStatus: "idle" });
    const row = store.findByThread(key);
    expect(row?.sessionId).toBe("sesn_1");
    expect(row?.lastStatus).toBe("idle");
  });

  it("upserts overwrites existing row", () => {
    store.upsert({ ...key, sessionId: "sesn_1", lastStatus: "idle" });
    store.upsert({ ...key, sessionId: "sesn_2", lastStatus: "running" });
    expect(store.findByThread(key)?.sessionId).toBe("sesn_2");
  });

  it("findBySessionId returns the row", () => {
    store.upsert({ ...key, sessionId: "sesn_1", lastStatus: "idle" });
    expect(store.findBySessionId("sesn_1")?.threadTs).toBe(key.threadTs);
  });

  it("setStatus updates only status + updated_at", () => {
    store.upsert({ ...key, sessionId: "sesn_1", lastStatus: "idle" });
    store.setStatus("sesn_1", "running");
    expect(store.findBySessionId("sesn_1")?.lastStatus).toBe("running");
  });

  it("setCurrentPlaceholder updates only placeholder ts", () => {
    store.upsert({ ...key, sessionId: "sesn_1", lastStatus: "idle" });
    store.setCurrentPlaceholder("sesn_1", "1700000001.000200");
    expect(store.findBySessionId("sesn_1")?.currentPlaceholderTs).toBe("1700000001.000200");
  });

  it("listRunning returns only running rows", () => {
    store.upsert({ ...key, sessionId: "sesn_1", lastStatus: "running" });
    store.upsert({
      teamId: "T1", channelId: "C2", threadTs: "1700000002.000300",
      sessionId: "sesn_2", lastStatus: "idle",
    });
    store.upsert({
      teamId: "T1", channelId: "C3", threadTs: "1700000003.000400",
      sessionId: "sesn_3", lastStatus: "running",
    });
    const ids = store.listRunning().map((r) => r.sessionId).sort();
    expect(ids).toEqual(["sesn_1", "sesn_3"]);
  });
});
