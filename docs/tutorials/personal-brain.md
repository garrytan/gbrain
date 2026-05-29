# Tutorial: Set up your personal AI agent + brain from zero

By the end of this tutorial you'll have your own AI agent running on a server you control, talking to you over Telegram, with a brain that remembers everything you tell it. About two hours end-to-end, $100 to $150 a month sustained.

This is the install I'd run if I were setting up the whole stack from scratch today. I documented it live during a setup session with a collaborator (we used Granola to capture the screen because "this is already too complicated for an archetypical person"). The tutorial is the cleaned-up version of that session.

> "This is the Apple I, we're just soldering breadboards over here."

If you only want the **brain layer** (no agent, no Telegram, just gbrain as memory for an MCP client you already use), skip to the [CLI standalone install](../INSTALL.md#2-cli-standalone) in INSTALL.md. If you want the whole agent **shared with a team**, read the [company brain tutorial](company-brain.md) instead. This tutorial is the solo, full-stack, talk-to-it-on-Telegram path.

---

## What you're building

A personal AI agent with four pieces:

- **A brain** (git repo). Your knowledge base, constantly ingesting and growing.
- **A harness** (OpenClaw via AlphaClaw). The runtime that gives the LLM tools, memory, and integrations.
- **A chat interface** (Telegram). How you talk to it.
- **Skills** (60+ installed via GBrain). Reusable capabilities the agent can invoke.

Architecture:

```
Telegram → AlphaClaw (harness) → OpenClaw (agent) → GBrain (knowledge/skills) → Supabase (embeddings/search)
```

Git repo is the system of record. The whole thing is multiplayer by default: any agent that hooks into the repo works. Conflicts resolve through git.

---

## Prerequisites

| Requirement | Why |
|---|---|
| GitHub account (org or personal) | For the two repos that store the agent + brain |
| Render account | For hosting the agent runtime |
| Telegram account | For talking to your agent |
| API keys: OpenAI, Anthropic at minimum | Embeddings + the Claude model |
| About $100 to $150 a month | Render Pro + Supabase + API usage |

---

## Step 1: Create two GitHub repos

You need two repos, not one.

1. **Workspace repo.** Agent configuration, skills, memory, crons. Example name: `your-org/myagent`. Private.
2. **Brain repo.** Knowledge base, people pages, meeting notes, all the content the agent reads and writes. Example name: `your-org/myagent-brain`. Private.

```
GitHub → New Repository → your-org/myagent           (workspace)
GitHub → New Repository → your-org/myagent-brain     (brain)
```

Both repos start empty. GBrain will populate the brain repo with its default structure on first install.

---

## Step 2: Generate a fine-grained Personal Access Token

GitHub → Settings → Developer Settings → Personal Access Tokens → Fine-grained tokens.

- **Name:** `myagent-token`
- **Expiration:** 1 year (or no expiration if available)
- **Repository access:** select both repos only
- **Permissions:** Read AND Write access to both repos (Contents, Metadata, Pull requests)

GitHub's fine-grained PAT UI is painful. You may need to reload the page after creating repos before they appear in the selector. This is the worst part of the whole setup. Push through.

Save this token. You'll need it for the AlphaClaw setup.

---

## Step 3: Create a Telegram bot

1. Open Telegram, message [@BotFather](https://t.me/BotFather)
2. Send `/newbot`
3. Name your bot (whatever you want)
4. Get the bot token
5. Save it. You'll need it for the AlphaClaw setup.

---

## Step 4: Deploy via AlphaClaw on Render

AlphaClaw is the setup harness that manages OpenClaw deployment.

1. Go to [alphaclaw.com](https://alphaclaw.com)
2. Enter your **workspace repo** (not the brain repo): `your-org/myagent`
3. Select "Use existing" if the repo already exists
4. Enter your GitHub PAT from Step 2
5. Enter your Telegram bot token from Step 3
6. Deploy

Render will build a Docker container with the harness. First deploy takes about 5 minutes.

**Memory matters.** If the instance runs out of memory during install, upgrade to Render Pro. The base tier is too small for GBrain + OpenClaw together. My production instance runs 48 cores and 64GB RAM (about $1,500 a month) but that's overkill for a new setup. Pro tier ($85 a month) is the minimum viable.

---

## Step 5: Add provider API keys

In the AlphaClaw UI (Providers tab):

- **OpenAI API Key.** Required for embeddings if you use the OpenAI provider.
- **Anthropic API Key.** Required for Claude (the main model the agent talks through).
- **Perplexity API Key.** Optional, for web search.
- **Voyage API Key.** Optional, alternative to OpenAI for embeddings.
- **ZeroEntropy API Key.** Recommended. GBrain ships with ZeroEntropy as the default embedder + reranker because it's about 2× faster than OpenAI and about 2.6× cheaper.

You can use the same keys across multiple agents.

---

## Step 6: Install GBrain

Once OpenClaw is running:

```bash
gbrain install
```

This installs:

- About 60 skills
- About 9 skill packs
- Default brain structure
- MCP server configuration
- Supabase connection (for embeddings and search)

GBrain populates the brain repo with its default directory structure, skill files, and configuration. From this point, the agent has working memory and access to every skill.

---

## Step 7: Set up Supabase (embeddings and search)

GBrain uses Supabase for vector embeddings and full-text search at scale. There are three setup gotchas I hit the hard way. Walk through them in this order.

### 7a. Create the project and turn on pgvector

1. Create a Supabase project at [supabase.com](https://supabase.com). Pick a region close to where your Render host runs.
2. In the Supabase dashboard, go to **Database → Extensions**.
3. Find `vector` (the pgvector extension) and toggle it on.

Skip this and every embed write fails with "type vector does not exist" the moment GBrain tries to create its schema. pgvector is what stores the embeddings; the schema migrations refuse to run without it. Five seconds in the UI; an hour of debugging if you forget.

### 7b. Get the CONNECTION POOLER connection string, not the direct one

In **Project Settings → Database → Connection string**, Supabase shows you two options. They look almost identical. Use the right one.

- **Direct connection** (port 5432). Talks straight to the Postgres instance. IPv6-only. Will fail if your Render host doesn't have IPv6 outbound (most don't by default).
- **Connection pooler** (port 6543, hostname starts with `aws-0-...pooler.supabase.com`). Talks through Supabase's pgbouncer. Works over IPv4. Survives connection storms from parallel workers.

You want the **connection pooler** string. Format looks like:

```
postgresql://postgres.YOUR-PROJECT:YOUR-PASSWORD@aws-0-us-west-1.pooler.supabase.com:6543/postgres
```

Configure it via:

```bash
gbrain config set database_url "postgresql://postgres.YOUR-PROJECT:YOUR-PASSWORD@aws-0-us-west-1.pooler.supabase.com:6543/postgres"
```

### 7c. Buy the IPv4 add-on if your host is IPv4-only

Even with the pooler, some Supabase regions and some Render plans hit IPv6 resolution snags. If your `gbrain doctor` shows connection failures and the error mentions "network unreachable" or hangs forever on connect, you need Supabase's **IPv4 add-on**.

In the Supabase dashboard, **Project Settings → Add-ons → IPv4 address**. About $4 a month. Toggle on, wait a minute, retry the connection. This bit me on multiple installs before I learned to just buy it up front.

### 7d. Verify the connection

```bash
gbrain doctor
```

Green checks on schema, connectivity, pgvector extension, embedding provider. If any of those are yellow, the message will tell you which gotcha you hit (and which of 7a / 7b / 7c to revisit).

### Operating note

Supabase is usually the scaling bottleneck, not CPU or LLM calls. If you're doing heavy ingestion (emails, calendar, Slack streaming in), upgrade from small to large DB instance early. Don't wait for the small instance to choke; the symptoms (silent failed inserts, sync timeouts, embedding backfill stalls) all look like different bugs but are the same bug.

---

## Step 8: Verify and chat

1. Open Telegram
2. Message your bot
3. It should respond using OpenClaw + GBrain

Send a test message. If it responds with context-awareness and can search the brain, you're live.

---

## Architecture notes

### Git as system of record

The brain repo IS the brain. Any agent that can read and write to the git repo can participate. This makes the architecture inherently multiplayer: multiple agents can share a brain, work on different parts, and resolve conflicts through git.

### Thin client vs fat client

- **Fat client** (my production setup). OpenClaw + AlphaClaw + GBrain + 200 crons + email processing + Slack + calendar. About $1,500 a month. Processes everything in real time.
- **Thin client** (what this tutorial builds). OpenClaw + GBrain + Telegram. About $85 a month. Chat-driven, on-demand.

The goal for GBrain is to make the thin client as awesome as the fat client. Most users will start thin and grow.

### MCP server

GBrain exposes a Model Context Protocol server that enables inter-agent communication and integration with external systems. This is how you add read and write access to your product's API, databases, or other services.

### Brain sharing

Brains share through git. My main agent can populate another agent's brain by pushing content to its repo. The MCP layer enables cross-agent brain queries. Just push to the git repo and the other agent picks it up on next sync.

---

## What this costs

| Component | Monthly cost |
|-----------|-------------|
| Render Pro (minimum viable) | about $85 |
| Supabase (small) | free to $25 |
| OpenAI API (embeddings) | $5 to $20 (much less if you use ZeroEntropy as the default) |
| Anthropic API (Claude) | $50 to $500 (usage dependent) |
| **Total minimum** | **about $100 to $150 a month** |

My production setup is about $10,000 a month, but that's 10 instances, 200 crons, processing email and Slack and calendar in real time, running sub-agents. Not what you need on day one.

> "Next year it's not going to cost $10,000 a month. It'll cost $1,000 a month. And then the year after that, it'll be $100 a month, and then everyone will have it."

---

## Common issues

1. **Render runs out of memory during install.** Upgrade to Pro tier.
2. **GitHub PAT can't see the repos.** Reload the page after creating repos. Make sure the fine-grained token has the correct repo selection.
3. **Telegram bot doesn't respond.** Check the bot token in AlphaClaw. Make sure the Render instance is actually running.
4. **Supabase bottleneck on heavy ingestion.** Upgrade the DB instance size before the small one chokes.
5. **GBrain.io provisioning fails.** The hosted instance may need Pro tier. Check the machine allocation in the AlphaClaw UI.

---

## What you built

You now have a personal AI agent running on Render, talking to you on Telegram, with a brain that ingests and remembers everything you tell it. Every conversation gets indexed, every new entity (person, company, deal, concept) gets its own page, the overnight enrichment daemon dedupes and consolidates while you sleep. You wake up with a smarter agent than the one you went to bed with.

Where to go next:

- **Wire ingestion** from external systems. Email, calendar, voice calls, tweets, Slack. The skills are already installed; you just configure the credentials. See [`docs/integrations/`](../integrations/) for per-source recipes.
- **Connect your existing AI client** (Claude Code, Cursor, Claude Desktop) to the same brain. See [`docs/mcp/`](../mcp/) for per-client setup.
- **Set up the dream cycle** properly. The autopilot daemon runs overnight enrichment by default but you can tune what it does. See [`docs/architecture/`](../architecture/) for the full cycle reference.
- **Add a teammate to your brain**, or stand the whole thing up as a company brain. See the [company brain tutorial](company-brain.md) for the multi-user walkthrough.

Questions, gotchas, or wins worth sharing? Open an issue at [github.com/garrytan/gbrain](https://github.com/garrytan/gbrain/issues).
