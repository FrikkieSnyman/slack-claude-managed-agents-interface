import bolt from "@slack/bolt";
import type { CmaClient } from "../cma/client.js";
import type { SessionDaemon, SlackWriter } from "../cma/session-daemon.js";
import { ThreadSessionStore, type ThreadKey } from "../store/thread-session-store.js";
import type { Config } from "../config.js";
import { logger } from "../logger.js";

const { App } = bolt;

export interface SlackEventCore {
  team?: string;
  channel: string;
  ts: string;
  thread_ts?: string;
  channel_type?: string;
}

export function deriveThreadKey(e: SlackEventCore): ThreadKey {
  const teamId = e.team ?? "unknown";
  const channelId = e.channel;
  if (e.thread_ts) return { teamId, channelId, threadTs: e.thread_ts };
  if (e.channel_type === "im") return { teamId, channelId, threadTs: channelId };
  return { teamId, channelId, threadTs: e.ts };
}

export interface HandleArgs {
  key: ThreadKey;
  text: string;
  store: ThreadSessionStore;
  client: CmaClient;
  getOrCreate: (sessionId: string) => Pick<SessionDaemon, "attachToTurn" | "sendUserMessage">;
  postPlaceholder: (key: ThreadKey) => Promise<string>;
  cmaConfig: {
    agentId: string;
    environmentId: string;
    vaultIds: string[];
    memoryStoreId: string | null;
  };
}

export async function handleInboundMessage(args: HandleArgs): Promise<void> {
  const { key, text, store, client, getOrCreate, postPlaceholder, cmaConfig } = args;

  let row = store.findByThread(key);
  let sessionId: string;

  if (!row || row.lastStatus === "terminated") {
    const created = await client.createSession({
      agentId: cmaConfig.agentId,
      environmentId: cmaConfig.environmentId,
      vaultIds: cmaConfig.vaultIds,
      memoryStoreId: cmaConfig.memoryStoreId,
    });
    sessionId = created.id;
    store.upsert({ ...key, sessionId, lastStatus: "idle" });
  } else {
    sessionId = row.sessionId;
  }

  const placeholderTs = await postPlaceholder(key);
  store.setCurrentPlaceholder(sessionId, placeholderTs);

  const daemon = getOrCreate(sessionId);
  daemon.attachToTurn(placeholderTs);
  await daemon.sendUserMessage(text);
}

export interface GatewayDeps {
  config: Config;
  store: ThreadSessionStore;
  client: CmaClient;
  getOrCreateDaemon: (sessionId: string) => SessionDaemon;
}

export function buildSlackApp(deps: GatewayDeps): bolt.App {
  const { config, store, client, getOrCreateDaemon } = deps;
  const app = new App({
    token: config.slack.botToken,
    appToken: config.slack.appToken,
    signingSecret: config.slack.signingSecret,
    socketMode: true,
    logLevel: bolt.LogLevel.INFO,
  });

  const handle = async (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    raw: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    slackClient: any,
  ): Promise<void> => {
    if (raw.bot_id || raw.subtype === "bot_message") return;
    if (!raw.text) return;
    const key = deriveThreadKey(raw as SlackEventCore);
    const text = stripBotMention(raw.text as string);

    try {
      await handleInboundMessage({
        key,
        text,
        store,
        client,
        getOrCreate: (id) => getOrCreateDaemon(id),
        postPlaceholder: async (k) => {
          const res = await slackClient.chat.postMessage({
            channel: k.channelId,
            thread_ts: k.threadTs === k.channelId ? undefined : k.threadTs,
            text: "⏳ Working on it…",
          });
          if (!res.ts) throw new Error("postMessage returned no ts");
          return res.ts as string;
        },
        cmaConfig: {
          agentId: config.cma.agentId,
          environmentId: config.cma.environmentId,
          vaultIds: config.cma.vaultIds,
          memoryStoreId: config.cma.memoryStoreId,
        },
      });
    } catch (err) {
      logger.error({ err, channel: raw.channel }, "handleInboundMessage failed");
      await slackClient.chat.postMessage({
        channel: raw.channel,
        thread_ts: raw.thread_ts ?? raw.ts,
        text: "❌ Couldn't reach the agent. Try again in a moment.",
      });
    }
  };

  app.event("app_mention", async ({ event, client: webClient }) => {
    await handle(event, webClient);
  });

  app.message(async ({ message, client: webClient }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((message as any).channel_type !== "im") return;
    await handle(message, webClient);
  });

  return app;
}

async function retryWithBackoff<T>(fn: () => Promise<T>, attempts: number, baseMs: number): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === attempts) break;
      await new Promise((r) => setTimeout(r, baseMs * Math.pow(2, i)));
    }
  }
  throw lastErr;
}

export function slackWriterFactory(
  config: Config,
  store: ThreadSessionStore,
  app: bolt.App,
): (sessionId: string) => SlackWriter {
  const postToChannel = async (channel: string, threadTs: string | undefined, text: string): Promise<string> => {
    const res = await app.client.chat.postMessage({ channel, thread_ts: threadTs, text });
    if (!res.ts) throw new Error("postMessage returned no ts");
    return res.ts;
  };

  return (sessionId) => ({
    async updatePlaceholder(messageTs, text) {
      const row = store.findBySessionId(sessionId);
      if (!row) return;
      await app.client.chat.update({ channel: row.channelId, ts: messageTs, text });
    },
    async postFinal(text) {
      const row = store.findBySessionId(sessionId);
      if (!row) throw new Error(`no row for session ${sessionId}`);
      const threadTs = row.threadTs === row.channelId ? undefined : row.threadTs;
      try {
        return await retryWithBackoff(() => postToChannel(row.channelId, threadTs, text), 2, 500);
      } catch (err) {
        logger.error({ err, sessionId }, "postFinal failed after retries");
        if (config.opsChannelId) {
          try {
            await postToChannel(
              config.opsChannelId,
              undefined,
              `postFinal failed for session ${sessionId} in <#${row.channelId}>: ${(err as Error).message ?? "unknown"}`,
            );
          } catch (opsErr) {
            logger.error({ opsErr, sessionId }, "ops-channel notify failed");
          }
        }
        throw err;
      }
    },
    async postError(text) {
      const row = store.findBySessionId(sessionId);
      if (!row) {
        if (!config.opsChannelId) throw new Error("no channel for postError");
        return postToChannel(config.opsChannelId, undefined, text);
      }
      const threadTs = row.threadTs === row.channelId ? undefined : row.threadTs;
      try {
        return await retryWithBackoff(() => postToChannel(row.channelId, threadTs, text), 2, 500);
      } catch (err) {
        logger.error({ err, sessionId }, "postError failed after retries");
        if (config.opsChannelId) {
          await postToChannel(config.opsChannelId, undefined, text).catch(() => {});
        }
        throw err;
      }
    },
  });
}

function stripBotMention(text: string): string {
  return text.replace(/^\s*<@[^>]+>\s*/, "").trim();
}
