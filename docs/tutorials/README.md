# Tutorials

Step-by-step walkthroughs that take you from zero to a working outcome. Concrete commands, real numbers, no abstraction-first jargon. Each tutorial assumes no prior Foresights knowledge.

## Shipped

- [**Set up your personal AI agent + brain from zero**](personal-brain.md) — the canonical solo install. Two GitHub repos, a Telegram bot, AlphaClaw on Render, OpenClaw + Foresights + Supabase. End-to-end in about 2 hours; about $100 to $150 a month sustained. The full-stack install I'd run today.
- [**Set up Foresights as your company brain**](company-brain.md) — federated, multi-user, OAuth-scoped institutional memory for a 10-50 person team. Three sources (shared / customers / internal-only), per-user scope, first synthesized query as a teammate. About 90 minutes end-to-end, about $5 in API calls for the demo, under $100 a month sustained for a 25-person company.
- [**Auto-improve a skill with `foresights skillopt`**](improving-skills-with-skillopt.md) — treat a `SKILL.md` as the trainable parameter of a frozen agent. Write your first benchmark from scratch (the part everyone gets stuck on), preview the cost, run the optimizer, read accepted vs no_improvement vs aborted, and accept a measurably better skill. About 20 minutes, about $1 in API calls. Reference: [`../guides/skillopt.md`](../guides/skillopt.md).
- [**Give your coding agent a memory: Foresights + Claude Code / Codex**](connect-coding-agent.md) — the two-funnel walkthrough for coding-agent users. Path A: connect Claude Code / Codex to a brain you already run (OpenClaw, Hermes, any `foresights serve --http`). Path B: start from nothing with a 2-second local PGLite brain. Both end with the brain-first protocol you paste into `CLAUDE.md` / `AGENTS.md` and the four habits (brain-first lookup, ambient capture, briefing-from-your-brain, whoknows) that make it worth it. About 10 minutes.

## In progress

These are the next tutorials on the roadmap. Open an issue if one of them is the one you need most; that's how we'll prioritize.

- **Set up Foresights for VC dealflow** — the operator's recipe. People pages for founders, companies with typed Facts fence carrying ARR / team-size / runway across dates, meetings auto-ingested, deal pages linking everything. Shows `foresights whoknows`, `foresights find-trajectory`, and `foresights founder scorecard` on real workflows.

- **Migrate your existing vault into Foresights** — for Notion / Obsidian / Roam users with a vault that doesn't match Foresights's default layout. Walks through `foresights schema detect` → `suggest` → `review-candidates` so the brain learns your shape instead of forcing you to learn its.

- **Index your codebase as a code brain** — for developers. Initialize a brain in a code repo, swap to `voyage-code-3` for embeddings, use `foresights code-def` / `foresights code-refs` / `foresights code-callers` to navigate the codebase semantically from any MCP-aware editor.

- **Run Foresights fully local with Ollama or llama.cpp** — for privacy-first deployments. No cloud calls, no API keys, no telemetry. Trades some retrieval quality for full local control. Useful for regulated industries, air-gapped environments, or just paranoia.

- **Set up the dream cycle** — the overnight enrichment daemon that makes the brain self-maintaining. Fixes citations, dedupes people pages, surfaces contradictions, generates founder scorecards on the schedule you configure. The piece that turns a static knowledge base into a brain that gets smarter while you sleep.

## Want to write one?

Tutorials follow the [Diataxis](https://diataxis.fr/) tutorial pattern: learning-oriented, walks a learner from zero to a working result in one session, every step produces a visible change. If you've used Foresights for something interesting and want to write the walkthrough, the existing [`company-brain.md`](company-brain.md) is the model. Open a PR.

## Related documentation

- **Reference:** [`docs/architecture/`](../architecture/) — system design, topologies, retrieval theory
- **How-to:** [`docs/guides/`](../guides/) — task-oriented runbooks (sub-agent routing, minion deployment, skill development, brain-first lookup, idea capture, diligence ingestion). Highlight: [scaling skills past 300](../guides/scaling-skills.md) — the three-tier architecture for agents that have outgrown the always-loaded skill manifest.
- **Integrations:** [`docs/integrations/`](../integrations/) — connecting external data sources (voice, email, calendar, embedding providers)
- **MCP setup:** [`docs/mcp/`](../mcp/) — per-client setup (Claude Desktop, Claude Code, Codex, ChatGPT, Perplexity, Cowork)
- **Install paths:** [`docs/INSTALL.md`](../INSTALL.md) — every install path, end to end
- **Agent bootstrap:** [`docs/guides/bootstrap.md`](../guides/bootstrap.md) — the paste-in path that turns a coding agent into a full agent (identity, per-turn context, schedules, a private repo as its durable body)
