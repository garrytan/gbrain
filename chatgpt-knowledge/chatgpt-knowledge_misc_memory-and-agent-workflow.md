---
title: "Memory and Agent Workflow"
type: guide
created: 2026-05-31
updated: 2026-05-31
source: chatgpt-export
topic: misc
message_count: 20
tags: [chatgpt, knowledge, misc]
---
**Topic:** [[chatgpt-knowledge/_topics/misc]]

# Memory and Agent Workflow

> **Source:** ChatGPT conversation
> **Date:** 2026-05-31T05:20:42Z
> **Messages:** 20
> **Topic:** misc

## Question

I'm just thinking about Jovi and um And what I want to just figure out right now is like, memory is the biggest thing. Memory makes everything better. Um, And also, um, what our agent workflow should be. I really would like to look and see, like, should it be agent SDK or should it be Trigger.dev? I need to make a decision today because we have issues that are about to ship with Trigger.dev and I'm wondering if that's not the move. Because we've talked about Versal workflows, we've talked about Trigger, there's Cloudflare stuff, there's all kinds of options now. There's, um, Anthropic has an SDK, um, OpenAI has an SDK and OpenAI one actually looks kind of good, and I'm just wondering if we should be building our own harness or if we should be leaning on another harness, um, and just, you know what I mean? Like, I don't know that it necessarily makes sense to recreate what OpenAI has already done for us, is kind of what I'm getting at. Um, and I wonder if this Versal thing is even gonna

## Answer

Mr. White, I’ll treat this as a same-day shipping decision: verify the current tooling, map it to your entity-memory graph, then recommend what to ship, avoid, and defer.

## Answer

Early read: keep the agent harness and durable workflow runner separate. The defensible layer is your product-owned entity-memory graph, while SDKs and runners can remain swappable.

## Answer

Mr. White,

## Same-day decision

**Ship with Trigger.dev as the durable workflow runner, OpenAI Agents SDK as the agent harness, and your own Jovie Memory Core as the source of truth.**

Do **not** pivot the current Trigger.dev work to Vercel Workflows, Cloudflare Workflows, Anthropic Managed Agents, or a fully custom harness today.

The right split is:

| Layer | Decision | Why |
|---|---:|---|
| **Durable workflows** | **Trigger.dev now** | You already have work about to ship; it handles long jobs, retries, queues, waits, callbacks, human checkpoints, observability, and runtime flexibility. |
| **Agent loop / tool calling** | **OpenAI Agents SDK** | It gives you agent primitives, tools, handoffs, guardrails, tracing, MCP support, sessions, and human-in-the-loop patterns without building your own loop. |
| **Connectors** | **Connector interface + selective Composio** | Use Composio to move fast on read-only/low-risk integrations, but keep it behind your own abstraction and avoid betting core OAuth/write flows on it immediately. |
| **Memory** | **Own the memory layer** | Jovie’s moat is the entity graph, provenance, permissions, asset links, and enrichment history. External memory tools can help indexing, but they should not own your canonical truth. |
| **Vector search** | **pgvector first; optional Graphiti/Zep later** | Vector search helps retrieval, but your real product needs a temporal entity/event/asset graph. |

---

## The key architecture point

**Agent SDKs and workflow systems solve different problems.**

The **OpenAI Agents SDK** is for deciding, calling tools, handing off between agents, tracing, using MCP tools, guardrails, sessions, and human approvals. OpenAI’s docs describe the SDK around agents, handoffs, guardrails, function tools, MCP, sessions, tracing, and human-in-the-loop support. citeturn684073view0turn684073view2turn684073view3turn684073view1

**Trigger.dev** is for keeping jobs alive and reliable: long-running work, retries, queues, idempotency, waits, callbacks, observability, versioning, human checkpoints, and runtime freedom for things like FFmpeg, browsers, Python scripts, and media jobs. That maps very directly to Jovie’s ingestion, enrichment, correlation, and content-generation workflows. citeturn990899view1turn990899view3turn990899view2

So the answer is **Trigger.dev plus OpenAI Agents SDK**, rather than one replacing the other.

---

## My recommendation

### 1. Keep Trigger.dev

Do not rip it out today.

Use Trigger as the **durable execution spine** for:

- ingesting photos, videos, voice memos, emails, calendar events, files, and chat mentions
- running enrichment jobs
- retrying flaky APIs
- waiting on OAuth callbacks
- waiting on user approvals
- running long media generation jobs
- coordinating multi-step workflows like “photo → person → email → calendar → location → song → opportunity”
- maintaining observability around each pipeline run

Trigger’s strongest fit for Jovie is that your work

*(Answer truncated — 22787 chars total)*

## Question

OK, what I'd like you to do now is ground this in Jovie's actual architecture currently and then end linear issues and stuff and what needs to happen. I want you to give me a giant spec prompt I can give to Codex and have it spin up sub-agents to take us from where we are to what I just described, laying out all that in front of everything. Have it use a swarm in isolated work trees and assign them all scopes, issues, and stuff for this. Have it go and turn this into a shipped thing. Explicitly describe what should be built now and what should be deferred with an issue open and then assigned. Have it triage the existing issues and update them or delete them or replace them based on any changes that are going to happen to the stack here. Do keep in mind that our Postgres is on neon and stuff like that. Make all those recommendations and the implementation plan, and then let's start going. 

## Answer

I’ll ground this against the live repo and Linear state first, then turn it into a Codex-ready orchestration prompt with scoped sub-agents, migration boundaries, and issue triage instructions.

## Answer

The repo already has many needed seams: pnpm/turbo, Next 16, Neon/Drizzle, connector/workflow/agent tables, existing ingestion, and guarded migrations. I’m checking schema, Trigger/Hermes, chat, and Linear next.

## Answer

Mr. White, I’m grounding this against the repo and Linear before writing the Codex prompt. One finding: the AgentOS ADR’s Vercel-primary choice applies to internal ops, not the creator-memory runtime.

## Answer

I found Jovie already has a partial connector/memory substrate on Neon with Google OAuth, Gmail/Calendar paths, workflow and agent run tables, plus a Vercel dry-run proof. The immediate work is a stack correction and schema fix, especially the Google provider enum mismatch, rather than a greenfield rebuild.

## Answer

I created the Memory Core / Content Engine Linear project and found the key repo constraint: internal AgentOS stays WDK/Vercel-oriented, while customer-facing memory workflows get a scoped Trigger.dev path.

## Answer

Created the Linear project **Memory Core / Content Engine** and started translating the plan into scoped work against Jovie’s current Neon/Drizzle repo architecture.

## Answer

I created the new Linear project and parent v0 issue, and I’m converting the architecture into scoped child tickets with current repo constraints included.

## Answer

I found a repo-level architecture conflict: AgentOS currently prefers WDK/Vercel Workflow, while Jovie Memory should use Trigger. I separated Memory Core into its own Linear project.

## Answer

I’ve created the urgent Linear project and parent v0 issue, and I’m turning the architecture decision into scoped child issues. I’m also reconciling older AgentOS, Trigger, Vercel, and WDK tickets so Codex follows one stack direction.

## Answer

I created a Linear project and parent shipping issue for the customer-facing Memory Core path, separate from internal AgentOS WDK/runtime experiments. The repo already has WDK and Vercel workflow artifacts, while connector and memory primitives live in `apps/web`.

## Answer

I created the new Linear project and parent issue, then started breaking the architecture decision into milestones and actionable tickets while triaging older WDK/Trigger items.

## Answer

I’ve created the Linear project and parent issue for the Memory Core / Content Engine track, and I’m converting the stack decision into scoped child issues. Next I’m reconciling older AgentOS, Trigger, and WDK issues so Codex gets a clean queue.

## Answer

I created the new Linear project and parent issue, then started breaking it into implementation slices and triaging older WDK/Trigger AgentOS tickets into a cleaner Codex queue.

## Answer

I also found a concrete repo blocker: connector tables and Google OAuth exist, but the connector enum lacks `gmail` and `google_calendar`. That should be M0 before broader memory workflows.

## Answer

I created the Linear project, milestones, and parent issue, then canceled a duplicate schema issue from a retry. I’m filling the implementation queue and reconciling older Trigger/WDK issues into a clean Codex execution graph.
