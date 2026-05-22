CREATE TABLE IF NOT EXISTS thread_sessions (
  team_id                TEXT NOT NULL,
  channel_id             TEXT NOT NULL,
  thread_ts              TEXT NOT NULL,
  session_id             TEXT NOT NULL,
  current_placeholder_ts TEXT,
  last_status            TEXT NOT NULL,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  PRIMARY KEY (team_id, channel_id, thread_ts)
);
CREATE INDEX IF NOT EXISTS idx_session_id  ON thread_sessions(session_id);
CREATE INDEX IF NOT EXISTS idx_last_status ON thread_sessions(last_status);
