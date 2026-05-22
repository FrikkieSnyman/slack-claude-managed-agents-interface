import { SessionDaemon, type SlackWriter } from "../cma/session-daemon.js";
import type { CmaClient } from "../cma/client.js";
import { ThreadSessionStore } from "../store/thread-session-store.js";
import { logger } from "../logger.js";

export interface DaemonRegistryOptions {
  idleTtlMs?: number;
  sweepIntervalMs?: number;
}

export type SlackWriterFactory = (sessionId: string) => SlackWriter;

export class DaemonRegistry {
  private readonly map = new Map<string, SessionDaemon>();
  private readonly idleTtlMs: number;
  private readonly sweepIntervalMs: number;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly client: CmaClient,
    private readonly store: ThreadSessionStore,
    private readonly slackWriterFor: SlackWriterFactory,
    opts: DaemonRegistryOptions = {},
  ) {
    this.idleTtlMs = opts.idleTtlMs ?? 1800 * 1000;
    this.sweepIntervalMs = opts.sweepIntervalMs ?? 60 * 1000;
  }

  getOrCreate(sessionId: string): SessionDaemon {
    let daemon = this.map.get(sessionId);
    if (daemon) return daemon;
    const slack = this.slackWriterFor(sessionId);
    daemon = new SessionDaemon({
      sessionId,
      client: this.client,
      slack,
      onStatusChange: (status) => {
        this.store.setStatus(sessionId, status);
        if (status === "terminated") {
          this.map.delete(sessionId);
        }
      },
    });
    this.map.set(sessionId, daemon);
    return daemon;
  }

  has(sessionId: string): boolean {
    return this.map.has(sessionId);
  }

  async restartAll(): Promise<void> {
    const rows = this.store.listRunning();
    await Promise.allSettled(
      rows.map(async (row) => {
        try {
          const remote = await this.client.retrieveSession(row.sessionId);
          if (remote.archived) {
            this.store.setStatus(row.sessionId, "terminated");
            this.map.delete(row.sessionId);
            logger.info({ sessionId: row.sessionId }, "restartAll: session archived externally, marking terminated");
            return;
          }
          if (remote.status === "running") {
            this.getOrCreate(row.sessionId);
            return;
          }
          if (remote.status === "terminated") {
            this.store.setStatus(row.sessionId, "terminated");
            try {
              await this.slackWriterFor(row.sessionId).postError(
                "⚠️ The agent session ended unexpectedly. Reply to start a new one.",
              );
            } catch (err) {
              logger.warn({ err, sessionId: row.sessionId }, "postError on restart failed");
            }
            return;
          }
          this.store.setStatus(row.sessionId, remote.status);
        } catch (err) {
          if (isNotFound(err)) {
            this.store.setStatus(row.sessionId, "terminated");
            try {
              await this.slackWriterFor(row.sessionId).postError(
                "⚠️ The agent session no longer exists. Reply to start a new one.",
              );
            } catch (postErr) {
              logger.warn({ postErr, sessionId: row.sessionId }, "postError on 404 failed");
            }
          } else {
            logger.warn({ err, sessionId: row.sessionId }, "restartAll: retrieve failed");
          }
        }
      }),
    );
  }

  evictIfIdle(sessionId: string): void {
    const daemon = this.map.get(sessionId);
    if (!daemon) return;
    if (!daemon.isIdle()) return;
    if (Date.now() - daemon.lastActivityAt() < this.idleTtlMs) return;
    void daemon.close();
    this.map.delete(sessionId);
  }

  startSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      for (const sessionId of this.map.keys()) this.evictIfIdle(sessionId);
    }, this.sweepIntervalMs);
  }

  stopSweep(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }
}

function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const status = (err as { status?: unknown }).status;
  return status === 404;
}
