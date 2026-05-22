import "dotenv/config";
import Database from "better-sqlite3";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { ThreadSessionStore } from "./store/thread-session-store.js";
import { DaemonRegistry } from "./registry/daemon-registry.js";
import { createCmaClient } from "./cma/client.js";
import { buildSlackApp, slackWriterFactory } from "./slack/gateway.js";

async function main(): Promise<void> {
  const config = loadConfig();
  logger.info("config loaded");

  mkdirSync(dirname(config.databasePath), { recursive: true });
  const db = new Database(config.databasePath);
  db.pragma("journal_mode = WAL");
  const store = new ThreadSessionStore(db);

  const client = createCmaClient(config.anthropic.apiKey);

  let slackWriter: ReturnType<typeof slackWriterFactory> | null = null;
  const registry = new DaemonRegistry(
    client,
    store,
    (sessionId) => {
      if (!slackWriter) throw new Error("slackWriter not yet initialized");
      return slackWriter(sessionId);
    },
    { idleTtlMs: config.daemonIdleTtlSeconds * 1000 },
  );

  const app = buildSlackApp({
    config,
    store,
    client,
    getOrCreateDaemon: (sessionId) => registry.getOrCreate(sessionId),
  });
  slackWriter = slackWriterFactory(config, store, app);

  await registry.restartAll();
  registry.startSweep();

  await app.start();
  logger.info("Slack app started (Socket Mode)");

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      logger.info({ signal }, "shutting down");
      registry.stopSweep();
      void app.stop().then(() => process.exit(0));
    });
  }
}

main().catch((err) => {
  logger.fatal({ err }, "fatal startup error");
  process.exit(1);
});
