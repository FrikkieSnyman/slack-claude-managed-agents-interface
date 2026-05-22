import type { CmaClient, EventStream } from "./client.js";
import {
  type RenderableEvent,
  isToolUseEvent,
  isToolResultEvent,
  isAgentMessageEvent,
  isStatusEvent,
  isErrorEvent,
  toolNameOf,
  toolInputPreviewOf,
  agentTextOf,
  getEventId,
  getToolUseIdFromResult,
} from "./event-types.js";
import { LogBuffer, renderLogBuffer, type RenderStatus } from "../slack/formatting.js";
import { CoalescingUpdater } from "../slack/rate-limiter.js";
import { logger } from "../logger.js";

export type StatusChange = "idle" | "running" | "rescheduling" | "terminated";

export interface SlackWriter {
  updatePlaceholder(messageTs: string, text: string): Promise<void>;
  postFinal(text: string): Promise<string>;
  postError(text: string): Promise<string>;
}

export interface SessionDaemonOptions {
  sessionId: string;
  client: CmaClient;
  slack: SlackWriter;
  onStatusChange: (status: StatusChange) => void;
  coalesceMs?: number;
  reconnect?: boolean;
}

export class SessionDaemon {
  private readonly sessionId: string;
  private readonly client: CmaClient;
  private readonly slack: SlackWriter;
  private readonly onStatusChange: (s: StatusChange) => void;
  private readonly buffer = new LogBuffer();
  private readonly updater: CoalescingUpdater<string>;
  private readonly seenEventIds = new Set<string>();

  private currentPlaceholderTs: string | null = null;
  private streamLoop: Promise<void> | null = null;
  private lastStatus: StatusChange = "idle";
  private agentTextAccumulator = "";
  private lastActivity = Date.now();
  private idleResolvers: Array<() => void> = [];
  private terminalResolvers: Array<() => void> = [];
  private reconnectAttempts = 0;
  private readonly reconnect: boolean;
  private lastErrorMessage: string | null = null;
  private reschedulingTimer: NodeJS.Timeout | null = null;

  constructor(opts: SessionDaemonOptions) {
    this.sessionId = opts.sessionId;
    this.client = opts.client;
    this.slack = opts.slack;
    this.onStatusChange = opts.onStatusChange;
    this.reconnect = opts.reconnect ?? true;
    this.updater = new CoalescingUpdater<string>(
      async (messageTs, text) => {
        try {
          await this.slack.updatePlaceholder(messageTs, text);
        } catch (err) {
          logger.warn({ err, sessionId: this.sessionId, messageTs }, "placeholder update failed");
        }
      },
      opts.coalesceMs ?? 1000,
    );
  }

  attachToTurn(placeholderTs: string): void {
    if (this.currentPlaceholderTs && this.currentPlaceholderTs !== placeholderTs && this.buffer.entries.length > 0) {
      const text = renderLogBuffer(this.buffer, "steered");
      void this.updater.flushNow(this.currentPlaceholderTs);
      void this.slack.updatePlaceholder(this.currentPlaceholderTs, text).catch((err) =>
        logger.warn({ err }, "final steer-tail update failed"),
      );
    }
    this.currentPlaceholderTs = placeholderTs;
    this.buffer.reset();
    this.agentTextAccumulator = "";
    this.scheduleRender("running");
  }

  async sendUserMessage(text: string): Promise<void> {
    this.lastActivity = Date.now();
    if (!this.streamLoop) {
      this.streamLoop = this.runStream();
    }
    await this.client.sendUserMessage(this.sessionId, text);
  }

  isIdle(): boolean {
    return this.lastStatus === "idle";
  }

  isTerminated(): boolean {
    return this.lastStatus === "terminated";
  }

  lastActivityAt(): number {
    return this.lastActivity;
  }

  waitForIdle(): Promise<void> {
    if (this.lastStatus === "idle") return Promise.resolve();
    return new Promise<void>((resolve) => this.idleResolvers.push(resolve));
  }

  waitForTerminal(): Promise<void> {
    if (this.lastStatus === "terminated") return Promise.resolve();
    return new Promise<void>((resolve) => this.terminalResolvers.push(resolve));
  }

  async close(): Promise<void> {
    if (this.currentPlaceholderTs) {
      await this.updater.flushNow(this.currentPlaceholderTs);
    }
  }

  private async runStream(): Promise<void> {
    while (true) {
      try {
        const stream = await this.client.streamEvents(this.sessionId);
        await this.consume(stream);
        this.reconnectAttempts = 0;
        if (this.lastStatus === "terminated") return;
        return;
      } catch (err) {
        logger.warn({ err, sessionId: this.sessionId, attempt: this.reconnectAttempts }, "stream error");
        if (!this.reconnect || this.reconnectAttempts >= 5) {
          logger.error({ sessionId: this.sessionId }, "giving up on stream reconnect");
          return;
        }
        const delay = Math.min(30_000, 1000 * Math.pow(2, this.reconnectAttempts));
        this.reconnectAttempts++;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  private async consume(stream: EventStream): Promise<void> {
    for await (const event of stream) {
      const id = getEventId(event);
      if (id && this.seenEventIds.has(id)) continue;
      if (id) this.seenEventIds.add(id);
      this.handle(event);
      if (this.lastStatus === "idle" || this.lastStatus === "terminated") {
        if (stream.close) stream.close();
        return;
      }
    }
  }

  private handle(event: RenderableEvent): void {
    this.lastActivity = Date.now();

    if (isToolUseEvent(event)) {
      const id = getEventId(event) ?? `local-${this.buffer.entries.length}`;
      this.buffer.append(id, toolNameOf(event), toolInputPreviewOf(event));
      this.scheduleRender("running");
      return;
    }

    if (isToolResultEvent(event)) {
      const useId = getToolUseIdFromResult(event);
      if (useId) this.buffer.markDone(useId);
      this.scheduleRender("running");
      return;
    }

    if (isAgentMessageEvent(event)) {
      this.agentTextAccumulator += agentTextOf(event);
      return;
    }

    if (isStatusEvent(event)) {
      this.applyStatus(event.type);
      return;
    }

    if (isErrorEvent(event)) {
      const message = extractErrorMessage(event);
      logger.warn({ sessionId: this.sessionId, message }, "session.error received");
      this.lastErrorMessage = message;
    }
  }

  private applyStatus(type: string): void {
    if (type === "session.status_idle") {
      this.lastStatus = "idle";
      this.scheduleRender("idle");
      this.clearReschedulingTimer();
      void this.completeTurn();
    } else if (type === "session.status_running") {
      this.lastStatus = "running";
      this.scheduleRender("running");
      this.clearReschedulingTimer();
    } else if (type === "session.status_rescheduled") {
      this.lastStatus = "rescheduling";
      this.scheduleRender("rescheduling");
      this.startReschedulingTimer();
    } else if (type === "session.status_terminated") {
      this.lastStatus = "terminated";
      this.scheduleRender("terminated");
      void this.completeTerminated();
    }
    this.onStatusChange(this.lastStatus);
  }

  private async completeTurn(): Promise<void> {
    const placeholderTs = this.currentPlaceholderTs;
    const finalText = this.agentTextAccumulator;
    this.agentTextAccumulator = "";
    this.buffer.reset();
    this.currentPlaceholderTs = null;
    this.streamLoop = null;
    this.clearReschedulingTimer();

    if (placeholderTs) {
      await this.updater.flushNow(placeholderTs);
    }
    if (finalText.trim().length > 0) {
      try {
        await this.slack.postFinal(finalText);
      } catch (err) {
        logger.error({ err, sessionId: this.sessionId }, "postFinal failed");
      }
    }
    this.idleResolvers.splice(0).forEach((r) => r());
  }

  private async completeTerminated(): Promise<void> {
    const placeholderTs = this.currentPlaceholderTs;
    this.currentPlaceholderTs = null;
    this.streamLoop = null;
    this.clearReschedulingTimer();

    if (placeholderTs) {
      await this.updater.flushNow(placeholderTs);
    }
    try {
      await this.slack.postError(
        "⚠️ The agent session ended unexpectedly. Reply to start a new one.",
      );
    } catch (err) {
      logger.error({ err, sessionId: this.sessionId }, "postError failed");
    }
    this.terminalResolvers.splice(0).forEach((r) => r());
    this.idleResolvers.splice(0).forEach((r) => r());
  }

  private startReschedulingTimer(): void {
    this.clearReschedulingTimer();
    this.reschedulingTimer = setTimeout(() => {
      if (this.lastStatus === "rescheduling") {
        this.scheduleRender("rescheduling_long");
      }
    }, 60_000);
  }

  private clearReschedulingTimer(): void {
    if (this.reschedulingTimer) {
      clearTimeout(this.reschedulingTimer);
      this.reschedulingTimer = null;
    }
  }

  private scheduleRender(status: RenderStatus): void {
    if (!this.currentPlaceholderTs) return;
    const text = renderLogBuffer(this.buffer, status, this.lastErrorMessage ?? undefined);
    this.updater.submit(this.currentPlaceholderTs, text);
  }
}

function extractErrorMessage(event: RenderableEvent): string {
  const err = event.error;
  if (err && typeof err === "object" && "message" in err && typeof (err as { message: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return "unknown error";
}
