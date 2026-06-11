import Anthropic from "@anthropic-ai/sdk";
import type { RenderableEvent } from "./event-types.js";
import type { GithubRepoConfig } from "../config.js";

export type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export interface InboundImage {
  mediaType: ImageMediaType;
  data: string; // base64
}

export interface UserMessage {
  text: string;
  images: InboundImage[];
}

type UserMessageContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: ImageMediaType; data: string } };

export function buildUserMessageContent(message: UserMessage): UserMessageContentBlock[] {
  const blocks: UserMessageContentBlock[] = [];
  if (message.text.trim().length > 0) {
    blocks.push({ type: "text", text: message.text });
  }
  for (const image of message.images) {
    blocks.push({
      type: "image",
      source: { type: "base64", media_type: image.mediaType, data: image.data },
    });
  }
  return blocks;
}

export interface EventStream extends AsyncIterable<RenderableEvent> {
  close?(): void;
}

export interface CmaSessionRef {
  id: string;
  status: "idle" | "running" | "rescheduling" | "terminated";
  archived: boolean;
}

export function isInvalidSessionError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const status = (err as { status?: unknown }).status;
  if (status === 404 || status === 410) return true;
  if (status !== 400 && status !== 409) return false;
  const message = String((err as { message?: unknown }).message ?? "").toLowerCase();
  return message.includes("archive") || message.includes("terminated") || message.includes("deleted");
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
  sendUserMessage(sessionId: string, message: UserMessage): Promise<void>;
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
      return {
        id: session.id,
        status: session.status as CmaSessionRef["status"],
        archived: session.archived_at !== null,
      };
    },

    async retrieveSession(sessionId) {
      const session = await anthropic.beta.sessions.retrieve(sessionId);
      return {
        id: session.id,
        status: session.status as CmaSessionRef["status"],
        archived: session.archived_at !== null,
      };
    },

    async sendUserMessage(sessionId, message) {
      await anthropic.beta.sessions.events.send(sessionId, {
        events: [{ type: "user.message", content: buildUserMessageContent(message) as never }],
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
