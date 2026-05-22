export type FlushFn<T> = (key: string, state: T) => Promise<void>;

interface Entry<T> {
  pending: T | undefined;
  lastFlushAt: number;
  timer: NodeJS.Timeout | null;
  flushing: boolean;
}

export class CoalescingUpdater<T> {
  private readonly entries = new Map<string, Entry<T>>();

  constructor(
    private readonly flush: FlushFn<T>,
    private readonly windowMs: number,
  ) {}

  submit(key: string, state: T): void {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { pending: undefined, lastFlushAt: 0, timer: null, flushing: false };
      this.entries.set(key, entry);
    }

    entry.pending = state;

    if (entry.timer !== null || entry.flushing) return;

    const now = Date.now();
    const elapsed = now - entry.lastFlushAt;
    const delay = elapsed >= this.windowMs ? 0 : this.windowMs - elapsed;
    entry.timer = setTimeout(() => void this.doFlush(key), delay);
  }

  async flushNow(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    await this.doFlush(key);
  }

  private async doFlush(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry || entry.pending === undefined) return;
    const state = entry.pending;
    entry.pending = undefined;
    entry.lastFlushAt = Date.now();
    entry.timer = null;
    entry.flushing = true;
    try {
      await this.flush(key, state);
    } finally {
      entry.flushing = false;
      if (entry.pending !== undefined) {
        entry.timer = setTimeout(() => void this.doFlush(key), this.windowMs);
      }
    }
  }
}
