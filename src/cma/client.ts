import Anthropic from "@anthropic-ai/sdk";
import type { RenderableEvent } from "./event-types.js";
import type { GithubRepoConfig } from "../config.js";

export interface EventStream extends AsyncIterable<RenderableEvent> {
  close?(): void;
}

export interface CmaSessionRef {
  id: string;
  status: "idle" | "running" | "rescheduling" | "terminated";
}

export interface CreateSessionInput {
  agentId: string;
  environmentId: string;
  vaultIds: string[];
  memoryStoreId: string | null;
  githubRepo: GithubRepoConfig | null;
}

export interface CmaClient {
  createSession(input: CreateSessionInput): Promise<CmaSessionRef>;
  retrieveSession(sessionId: string): Promise<CmaSessionRef>;
  sendUserMessage(sessionId: string, text: string): Promise<void>;
  streamEvents(sessionId: string): Promise<EventStream>;
  listEvents(sessionId: string): AsyncIterable<RenderableEvent>;
}

type MemoryStoreResource = {
  type: "memory_store";
  memory_store_id: string;
  access: "read_write";
};

type GithubRepoResource = {
  type: "github_repository";
  url: string;
  authorization_token: string;
  checkout?: { type: "branch"; name: string } | { type: "commit"; sha: string };
  mount_path?: string;
};

export type SessionResourceParam = MemoryStoreResource | GithubRepoResource;

export function buildSessionResources(input: {
  memoryStoreId: string | null;
  githubRepo: GithubRepoConfig | null;
}): SessionResourceParam[] {
  const resources: SessionResourceParam[] = [];
  if (input.memoryStoreId) {
    resources.push({
      type: "memory_store",
      memory_store_id: input.memoryStoreId,
      access: "read_write",
    });
  }
  if (input.githubRepo) {
    const repo: GithubRepoResource = {
      type: "github_repository",
      url: input.githubRepo.url,
      authorization_token: input.githubRepo.authToken,
    };
    if (input.githubRepo.commit) {
      repo.checkout = { type: "commit", sha: input.githubRepo.commit };
    } else if (input.githubRepo.branch) {
      repo.checkout = { type: "branch", name: input.githubRepo.branch };
    }
    if (input.githubRepo.mountPath) {
      repo.mount_path = input.githubRepo.mountPath;
    }
    resources.push(repo);
  }
  return resources;
}

export function createCmaClient(apiKey: string): CmaClient {
  const anthropic = new Anthropic({ apiKey });

  return {
    async createSession({ agentId, environmentId, vaultIds, memoryStoreId, githubRepo }) {
      const resources = buildSessionResources({ memoryStoreId, githubRepo });
      const session = await anthropic.beta.sessions.create({
        agent: agentId,
        environment_id: environmentId,
        ...(vaultIds.length > 0 ? { vault_ids: vaultIds } : {}),
        ...(resources.length > 0 ? { resources: resources as never } : {}),
      });
      return { id: session.id, status: session.status as CmaSessionRef["status"] };
    },

    async retrieveSession(sessionId) {
      const session = await anthropic.beta.sessions.retrieve(sessionId);
      return { id: session.id, status: session.status as CmaSessionRef["status"] };
    },

    async sendUserMessage(sessionId, text) {
      await anthropic.beta.sessions.events.send(sessionId, {
        events: [{ type: "user.message", content: [{ type: "text", text }] }],
      });
    },

    async streamEvents(sessionId) {
      const stream = await anthropic.beta.sessions.events.stream(sessionId);
      return stream as unknown as EventStream;
    },

    listEvents(sessionId) {
      return anthropic.beta.sessions.events.list(sessionId) as unknown as AsyncIterable<RenderableEvent>;
    },
  };
}
