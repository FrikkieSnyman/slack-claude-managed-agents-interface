import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type Database from "better-sqlite3";

const __dirname = dirname(fileURLToPath(import.meta.url));

export type SessionStatus = "idle" | "running" | "rescheduling" | "terminated";

export interface ThreadKey {
  teamId: string;
  channelId: string;
  threadTs: string;
}

export interface ThreadSessionRow extends ThreadKey {
  sessionId: string;
  currentPlaceholderTs: string | null;
  lastStatus: SessionStatus;
  createdAt: number;
  updatedAt: number;
}

export interface UpsertInput extends ThreadKey {
  sessionId: string;
  lastStatus: SessionStatus;
  currentPlaceholderTs?: string | null;
}

interface RawRow {
  team_id: string;
  channel_id: string;
  thread_ts: string;
  session_id: string;
  current_placeholder_ts: string | null;
  last_status: SessionStatus;
  created_at: number;
  updated_at: number;
}

function toRow(r: RawRow): ThreadSessionRow {
  return {
    teamId: r.team_id,
    channelId: r.channel_id,
    threadTs: r.thread_ts,
    sessionId: r.session_id,
    currentPlaceholderTs: r.current_placeholder_ts,
    lastStatus: r.last_status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class ThreadSessionStore {
  constructor(private readonly db: Database.Database) {
    const schema = readFileSync(join(__dirname, "schema.sql"), "utf-8");
    db.exec(schema);
  }

  findByThread(key: ThreadKey): ThreadSessionRow | null {
    const row = this.db
      .prepare<[string, string, string], RawRow>(
        `SELECT * FROM thread_sessions WHERE team_id = ? AND channel_id = ? AND thread_ts = ?`,
      )
      .get(key.teamId, key.channelId, key.threadTs);
    return row ? toRow(row) : null;
  }

  findBySessionId(sessionId: string): ThreadSessionRow | null {
    const row = this.db
      .prepare<[string], RawRow>(`SELECT * FROM thread_sessions WHERE session_id = ?`)
      .get(sessionId);
    return row ? toRow(row) : null;
  }

  upsert(input: UpsertInput): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO thread_sessions
           (team_id, channel_id, thread_ts, session_id, current_placeholder_ts, last_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(team_id, channel_id, thread_ts) DO UPDATE SET
           session_id = excluded.session_id,
           current_placeholder_ts = excluded.current_placeholder_ts,
           last_status = excluded.last_status,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.teamId,
        input.channelId,
        input.threadTs,
        input.sessionId,
        input.currentPlaceholderTs ?? null,
        input.lastStatus,
        now,
        now,
      );
  }

  setStatus(sessionId: string, status: SessionStatus): void {
    this.db
      .prepare(`UPDATE thread_sessions SET last_status = ?, updated_at = ? WHERE session_id = ?`)
      .run(status, Date.now(), sessionId);
  }

  setCurrentPlaceholder(sessionId: string, ts: string | null): void {
    this.db
      .prepare(
        `UPDATE thread_sessions SET current_placeholder_ts = ?, updated_at = ? WHERE session_id = ?`,
      )
      .run(ts, Date.now(), sessionId);
  }

  listRunning(): ThreadSessionRow[] {
    return this.db
      .prepare<[], RawRow>(`SELECT * FROM thread_sessions WHERE last_status = 'running'`)
      .all()
      .map(toRow);
  }
}
