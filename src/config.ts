export interface GithubRepoConfig {
  url: string;
  authToken: string;
  branch: string | null;
  commit: string | null;
  mountPath: string | null;
}

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
    githubRepo: GithubRepoConfig | null;
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

function loadGithubRepoConfig(env: Record<string, string | undefined>): GithubRepoConfig | null {
  const url = env.CMA_GITHUB_REPO_URL;
  if (!url) return null;
  const authToken = env.CMA_GITHUB_TOKEN;
  if (!authToken) {
    throw new Error("CMA_GITHUB_TOKEN is required when CMA_GITHUB_REPO_URL is set");
  }
  const branch = env.CMA_GITHUB_BRANCH ?? null;
  const commit = env.CMA_GITHUB_COMMIT ?? null;
  if (branch && commit) {
    throw new Error("CMA_GITHUB_BRANCH and CMA_GITHUB_COMMIT are mutually exclusive");
  }
  return {
    url,
    authToken,
    branch,
    commit,
    mountPath: env.CMA_GITHUB_MOUNT_PATH ?? null,
  };
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
      githubRepo: loadGithubRepoConfig(env),
    },
    databasePath: env.DATABASE_PATH ?? "./data/sessions.db",
    daemonIdleTtlSeconds: Number(env.DAEMON_IDLE_TTL_SECONDS ?? 1800),
    opsChannelId: env.OPS_CHANNEL_ID ?? null,
  };
}
