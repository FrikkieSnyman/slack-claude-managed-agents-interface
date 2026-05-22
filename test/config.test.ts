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
});
