# slack-claude-managed-agents-interface

Single-process Node/TypeScript server that bridges a Slack workspace to a Claude Managed Agents (CMA) agent.

- **Input**: Slack app mentions and DMs
- **Mapping**: one CMA session per Slack thread
- **Progress UX**: edits a placeholder message with a running log of tool calls; posts a new message with the final answer (so the user gets a notification)

## Prerequisites

- Node 20+
- A configured CMA agent + environment (and optional vault / memory store)
- A Slack app installed to your workspace with Socket Mode enabled and these bot scopes:
  - `app_mentions:read`, `chat:write`
  - `im:history`, `im:read`, `im:write` (DMs)
  - `channels:history` (to receive in-thread follow-ups in public channels)
  - `groups:history` (optional — same for private channels the bot is invited to)
- Event subscriptions:
  - `app_mention` — picks up @mentions
  - `message.im` — DMs
  - `message.channels` — in-thread follow-ups in public channels (filtered server-side to threads with a known session)
  - `message.groups` — same for private channels

## Setup

```bash
cp .env.example .env
# Fill in tokens and IDs
npm install
npm run dev
```

## Environment variables

See `.env.example`. Required: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_SIGNING_SECRET`, `ANTHROPIC_API_KEY`, `CMA_AGENT_ID`, `CMA_ENVIRONMENT_ID`. Optional: `CMA_VAULT_IDS` (comma-separated), `CMA_MEMORY_STORE_ID`, `DATABASE_PATH`, `LOG_LEVEL`, `DAEMON_IDLE_TTL_SECONDS`, `OPS_CHANNEL_ID`.

### Mounting a GitHub repo

If set, every new CMA session mounts the repo into its container (default at `/workspace/<repo-name>`):

- `CMA_GITHUB_REPO_URL` — e.g. `https://github.com/owner/repo`
- `CMA_GITHUB_TOKEN` — PAT or fine-grained token with `Contents: read` on the repo. Required when URL is set.
- `CMA_GITHUB_BRANCH` — optional; defaults to the repo's default branch
- `CMA_GITHUB_COMMIT` — optional; pin to a specific SHA. Mutually exclusive with `CMA_GITHUB_BRANCH`.
- `CMA_GITHUB_MOUNT_PATH` — optional; override the default mount path

Existing sessions keep their original mount; only new sessions pick up changes. Restart the server after changing these to be safe.

## Tests

```bash
npm test            # unit + integration with mocked SDKs
npm run typecheck   # tsc --noEmit
```

## Manual verification (first deploy)

1. **DM reply**: DM the bot. It should post a placeholder, then a final-answer message.
2. **Channel mention threading**: `@bot` in a channel. The bot's reply should land in a new thread under the mention.
3. **Notification on done**: Final-answer message must be a new post (not just an edit) so Slack notifies you.
4. **Restart resilience**: Send a long-running request; while it's still running, restart the server (`pkill node` then `npm run dev`). The placeholder should resume updating on its own (eager reconnect).
5. **Terminated session**: If a session terminates (e.g. CMA error), the bot should post `"⚠️ The agent session ended unexpectedly. Reply to start a new one."` and the next reply starts a fresh session.

## Architecture

See `docs/superpowers/specs/2026-05-22-slack-cma-bridge-design.md` (local; intentionally gitignored).

## Non-goals

Multi-workspace install, Slack Assistant pane, slash commands, multi-agent selection, HTTP Events API, horizontal scaling, file uploads.
