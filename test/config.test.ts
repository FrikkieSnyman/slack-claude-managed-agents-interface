import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

const minimal = {
  SLACK_BOT_TOKEN: "xoxb-test",
  SLACK_APP_TOKEN: "xapp-test",
  SLACK_SIGNING_SECRET: "secret",
  ANTHROPIC_API_KEY: "sk-ant-test",
  CMA_AGENT_ID: "agent_1",
  CMA_ENVIRONMENT_ID: "env_1",
};

describe("loadConfig", () => {
  it("loads required vars", () => {
    const cfg = loadConfig(minimal);
    expect(cfg.slack.botToken).toBe("xoxb-test");
    expect(cfg.cma.agentId).toBe("agent_1");
  });

  it("parses optional vault ids as array", () => {
    const cfg = loadConfig({ ...minimal, CMA_VAULT_IDS: "v1,v2,v3" });
    expect(cfg.cma.vaultIds).toEqual(["v1", "v2", "v3"]);
  });

  it("defaults daemon idle ttl to 1800s", () => {
    const cfg = loadConfig(minimal);
    expect(cfg.daemonIdleTtlSeconds).toBe(1800);
  });

  it("defaults database path", () => {
    const cfg = loadConfig(minimal);
    expect(cfg.databasePath).toBe("./data/sessions.db");
  });

  it("throws naming the missing var", () => {
    const { SLACK_BOT_TOKEN, ...rest } = minimal;
    expect(() => loadConfig(rest)).toThrow(/SLACK_BOT_TOKEN/);
  });

  it("githubRepo is null when CMA_GITHUB_REPO_URL is unset", () => {
    expect(loadConfig(minimal).cma.githubRepo).toBeNull();
  });

  it("loads githubRepo with url + token", () => {
    const cfg = loadConfig({
      ...minimal,
      CMA_GITHUB_REPO_URL: "https://github.com/owner/repo",
      CMA_GITHUB_TOKEN: "ghp_xxx",
    });
    expect(cfg.cma.githubRepo).toEqual({
      url: "https://github.com/owner/repo",
      authToken: "ghp_xxx",
      branch: null,
      commit: null,
      mountPath: null,
    });
  });

  it("loads optional branch and mountPath", () => {
    const cfg = loadConfig({
      ...minimal,
      CMA_GITHUB_REPO_URL: "https://github.com/o/r",
      CMA_GITHUB_TOKEN: "t",
      CMA_GITHUB_BRANCH: "develop",
      CMA_GITHUB_MOUNT_PATH: "/workspace/r",
    });
    expect(cfg.cma.githubRepo?.branch).toBe("develop");
    expect(cfg.cma.githubRepo?.mountPath).toBe("/workspace/r");
  });

  it("loads optional commit", () => {
    const cfg = loadConfig({
      ...minimal,
      CMA_GITHUB_REPO_URL: "https://github.com/o/r",
      CMA_GITHUB_TOKEN: "t",
      CMA_GITHUB_COMMIT: "abc123",
    });
    expect(cfg.cma.githubRepo?.commit).toBe("abc123");
  });

  it("throws if repo URL is set without a token", () => {
    expect(() =>
      loadConfig({ ...minimal, CMA_GITHUB_REPO_URL: "https://github.com/o/r" }),
    ).toThrow(/CMA_GITHUB_TOKEN/);
  });

  it("throws if both branch and commit are set", () => {
    expect(() =>
      loadConfig({
        ...minimal,
        CMA_GITHUB_REPO_URL: "https://github.com/o/r",
        CMA_GITHUB_TOKEN: "t",
        CMA_GITHUB_BRANCH: "main",
        CMA_GITHUB_COMMIT: "abc",
      }),
    ).toThrow(/mutually exclusive/);
  });
});
