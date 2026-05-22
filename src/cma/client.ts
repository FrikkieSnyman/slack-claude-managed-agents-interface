import Anthropic from "@anthropic-ai/sdk";
import type { RenderableEvent } from "./event-types.js";

export interface EventStream extends AsyncIterable<RenderableEvent> {
  close?(): void;
}

export interface CmaSessionRef {
  id: string;
  status: "idle" | "running" | "rescheduling" | "terminated";
}

export interface CmaClient {
  createSession(input: {
    agentId: string;
    environmentId: string;
    vaultIds: string[];
    memoryStoreId: string | null;
  }): Promise<CmaSessionRef>;

  retrieveSession(sessionId: string): Promise<CmaSessionRef>;

  sendUserMessage(sessionId: string, text: string): Promise<void>;

  streamEvents(sessionId: string): Promise<EventStream>;

  listEvents(sessionId: string): AsyncIterable<RenderableEvent>;
}

export function createCmaClient(apiKey: string): CmaClient {
  const anthropic = new Anthropic({ apiKey });

  return {
    async createSession({ agentId, environmentId, vaultIds, memoryStoreId }) {
      const resources = memoryStoreId
        ? [{ type: "memory_store" as const, memory_store_id: memoryStoreId, access: "read_write" as const }]
        : undefined;
      const session = await anthropic.beta.sessions.create({
        agent: agentId,
        environment_id: environmentId,
        ...(vaultIds.length > 0 ? { vault_ids: vaultIds } : {}),
        ...(resources ? { resources } : {}),
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
