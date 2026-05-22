import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CoalescingUpdater } from "../../src/slack/rate-limiter.js";

describe("CoalescingUpdater", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("invokes once for a single submit", async () => {
    const flush = vi.fn(async () => {});
    const updater = new CoalescingUpdater(flush, 1000);

    updater.submit("key1", "state-a");
    await vi.advanceTimersByTimeAsync(1100);

    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith("key1", "state-a");
  });

  it("coalesces rapid updates to the latest state", async () => {
    const flush = vi.fn(async () => {});
    const updater = new CoalescingUpdater(flush, 1000);

    updater.submit("key1", "state-a");
    updater.submit("key1", "state-b");
    updater.submit("key1", "state-c");
    await vi.advanceTimersByTimeAsync(1100);

    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith("key1", "state-c");
  });

  it("flushes immediately on first submit then coalesces follow-ups", async () => {
    const flush = vi.fn(async () => {});
    const updater = new CoalescingUpdater(flush, 1000);

    updater.submit("k", "a");
    await vi.advanceTimersByTimeAsync(10);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenLastCalledWith("k", "a");

    updater.submit("k", "b");
    updater.submit("k", "c");
    await vi.advanceTimersByTimeAsync(1100);
    expect(flush).toHaveBeenCalledTimes(2);
    expect(flush).toHaveBeenLastCalledWith("k", "c");
  });

  it("tracks separate windows per key", async () => {
    const flush = vi.fn(async () => {});
    const updater = new CoalescingUpdater(flush, 1000);

    updater.submit("k1", "a");
    updater.submit("k2", "b");
    await vi.advanceTimersByTimeAsync(1100);

    expect(flush).toHaveBeenCalledWith("k1", "a");
    expect(flush).toHaveBeenCalledWith("k2", "b");
  });

  it("flush forces immediate write of pending state", async () => {
    const flush = vi.fn(async () => {});
    const updater = new CoalescingUpdater(flush, 1000);

    updater.submit("k", "a");
    await vi.advanceTimersByTimeAsync(10);
    updater.submit("k", "b");

    await updater.flushNow("k");
    expect(flush).toHaveBeenCalledTimes(2);
    expect(flush).toHaveBeenLastCalledWith("k", "b");
  });
});
