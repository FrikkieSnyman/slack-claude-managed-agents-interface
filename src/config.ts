export interface Config {
  slack: {
    botToken: string;
    appToken: string;
    signingSecret: string;
  };
  anthropic: {
    apiKey: string;
  };
  cma: {
    agentId: string;
    environmentId: string;
    vaultIds: string[];
    memoryStoreId: string | null;
  };
  databasePath: string;
  daemonIdleTtlSeconds: number;
  opsChannelId: string | null;
}

function required(env: Record<string, string | undefined>, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return {
    slack: {
      botToken: required(env, "SLACK_BOT_TOKEN"),
      appToken: required(env, "SLACK_APP_TOKEN"),
      signingSecret: required(env, "SLACK_SIGNING_SECRET"),
    },
    anthropic: {
      apiKey: required(env, "ANTHROPIC_API_KEY"),
    },
    cma: {
      agentId: required(env, "CMA_AGENT_ID"),
      environmentId: required(env, "CMA_ENVIRONMENT_ID"),
      vaultIds: (env.CMA_VAULT_IDS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      memoryStoreId: env.CMA_MEMORY_STORE_ID ?? null,
    },
    databasePath: env.DATABASE_PATH ?? "./data/sessions.db",
    daemonIdleTtlSeconds: Number(env.DAEMON_IDLE_TTL_SECONDS ?? 1800),
    opsChannelId: env.OPS_CHANNEL_ID ?? null,
  };
}
