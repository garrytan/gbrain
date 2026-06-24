# GBrain mode selection

Use this guide after install, before wiring agents or recurring jobs. GBrain
uses "mode" in two different ways:

- **Operational command:** what you ask GBrain to do now: retrieve, synthesize,
  maintain, or volunteer context.
- **Search mode bundle:** the cost/quality profile behind retrieval:
  `conservative`, `balanced`, or `tokenmax`.

## Quick decision

| Need | Use | Why |
|---|---|---|
| Find raw pages, citations, or candidate context | `gbrain search "<query>"` | Cheap-hybrid retrieval. It returns ranked evidence without a synthesis LLM call. |
| Get a written answer with citations and gap analysis | `gbrain think "<question>"` | Runs retrieval, then composes an answer and calls out stale, missing, or conflicting evidence. |
| Keep the brain healthy over time | `gbrain dream` or `gbrain autopilot --install` | Runs maintenance, extraction, consolidation, and enrichment work instead of answering one question. |
| Let the brain volunteer context during an agent session | retrieval reflex, `volunteer_context`, `gbrain volunteer-context`, or `gbrain watch` | Pushes confidence-gated page pointers from recent conversation turns, so agents do not need to guess when to ask. |
| Get a ranked read-only "what should I do next?" list | `gbrain advisor` | Surfaces pending migrations, stalled work, setup smells, embedding coverage, and other high-leverage actions without taking action automatically. |

Do not invent a separate `chat` command in docs or agent protocols. The current
public answer command is `gbrain think`; raw retrieval is `gbrain search` or
the lower-level `gbrain query` operation when you need its extra controls.

## Retrieval: `gbrain search`

Use `gbrain search "<query>"` when you want evidence, not prose. Good cases:

- find the page or quote behind a user question;
- collect context before an agent writes or edits a page;
- check whether a person, company, project, or topic already exists;
- verify that sync/import made specific text discoverable.

The command has two public shapes:

```bash
gbrain search "acme-example board meeting"
gbrain search modes
gbrain search stats --days 30
gbrain search tune
gbrain search diagnose "acme-example" --target companies/acme-example
```

Free-text `gbrain search "<query>"` is the cheap-hybrid path: vector + keyword +
RRF + ranking improvements, with multi-query LLM expansion off. The
`modes` / `stats` / `tune` / `diagnose` subcommands are the search dashboard and
debug path, not searches for those literal words.

Safety and cost notes:

- `search` is a read-scoped operation and is the safest default for agents that
  only need context.
- Per-call `--mode` is honored only for trusted local callers. Remote callers
  use the configured brain mode, so an OAuth client cannot silently escalate to
  a more expensive retrieval bundle.
- `search.mcp_keyword_only=true` forces keyword-only retrieval when the operator
  wants to avoid sending query text to an embedding provider.
- Search returns evidence snippets. Fetch the full page when the surrounding
  context matters.

Use the lower-level `gbrain query` operation only when you need controls that
`search` intentionally hides: image query, expansion/detail knobs, adaptive
return overrides, autocut overrides, relational retrieval debugging, or
advanced eval/replay work.

## Synthesis: `gbrain think`

Use `gbrain think "<question>"` when the user wants the answer, not a list of
pages.

Good cases:

- meeting prep;
- "what do we know about X?";
- "what changed since last time?";
- cross-page questions that need graph context, typed facts, or trajectory
  signals;
- answer drafting where citations and gaps matter.

`think` gathers relevant pages, takes, graph hits, and optional temporal /
trajectory context, then writes a cited answer with gap analysis. It costs more
than `search` because it uses a synthesis model when one is configured.

Safety notes:

- Without `--save`, CLI output is printed and discarded.
- With `--save`, local CLI can persist a synthesis page. With `--take`, local
  CLI can append a take to an anchor page.
- Thin-client and remote MCP callers do not get to persist through `think`;
  `save` and `take` are blocked at the trust boundary.
- An explicit unresolved `--model` is a hard error. Omitted model selection can
  follow configured defaults.

## Maintenance: `gbrain dream` and autopilot

Use maintenance modes when the goal is to improve the brain, not answer the
current turn.

| Surface | Best use | Operator gate |
|---|---|---|
| `gbrain dream` | Run one maintenance cycle, often from cron or an approved manual task. | Confirm provider keys, cost expectations, and phase scope before scheduling. |
| `gbrain autopilot --install` | Keep a brain self-maintaining through a daemonized loop. | Confirm cadence, budget/cost caps, process ownership, and stop/recovery path. |
| `gbrain doctor --remediation-plan --json` | Preview fix work before applying it. | Review the plan before `--remediate --yes`. |

Maintenance can submit protected work such as synthesis, patterns, and
consolidation. Those paths are for trusted local operation and controlled
automation, not arbitrary remote agent escalation.

## Push context

Push context is for agent sessions where the brain should volunteer relevant
pages before the agent explicitly searches. It is zero-LLM and confidence-gated:
alias matches start high, exact title matches are strong, slug-suffix matches
need a lower confidence gate, and the default cap is three pages.

| Channel | Use when | How it behaves |
|---|---|---|
| Retrieval reflex | The host/plugin context engine supports it. | Ambient default. It reads the recent turn window and injects pointer markdown when salient entities clear the gate. It is fail-open and time-bounded. |
| MCP `volunteer_context` | An agent can call tools but does not have the ambient context engine. | Send recent turns plus optional `prior_context`; get page pointers, rationales, and synopses back. |
| `gbrain volunteer-context` | CLI or scripted one-shot push context. | Pipe recent turns on stdin. Use `--stats` to inspect approximate volunteered-vs-used precision. |
| `gbrain watch` | You have a transcript stream and want volunteered pages as turns arrive. | Reads stdin continuously and emits volunteered pages, with `--json` for JSONL consumers. |

For PGLite brains, `gbrain watch` holds the single-writer engine for the session
and cannot run alongside `gbrain serve` or another GBrain process against the
same brain. Use short piped bursts, the ambient reflex channel, or Postgres when
you need concurrent long-running access.

Push-context privacy notes:

- Raw conversation text is not stored in the volunteer feedback log.
- Logged volunteer events carry slug, arm, confidence, channel, and optional
  session/turn attribution.
- Usage stats are approximate: a volunteered page is counted as "used" when the
  page was retrieved after it was volunteered.
- Synopses strip private takes/facts fences before prompt delivery.

## Search mode bundles

Choose the search mode once per brain or source unless usage proves it is wrong.
The bundle controls token budget, result count, expansion, reranker/autocut
behavior, graph signals, and contextual retrieval defaults.

| Mode | Use when | Cost/quality shape |
|---|---|---|
| `conservative` | Haiku-class subagents, high-volume loops, cost-sensitive automation. | 4K token budget, 10-result shape, no LLM expansion, lowest spend. |
| `balanced` | Most Sonnet-tier users and shared brains. | 12K token budget, 25-result shape, strong defaults without expansion. |
| `tokenmax` | Frontier-model workflows where recall matters more than spend. | No token cap, 50-result shape, LLM expansion on. Highest recall and highest spend. |

Inspect and change the active mode:

```bash
gbrain search modes
gbrain config set search.mode balanced
```

Agents must not silently accept the install default. Follow the stop-and-ask
protocol in `INSTALL_FOR_AGENTS.md` and show the cost matrix before continuing.

Search mode is not the same as spend posture. Search mode controls retrieval
recall and token shape; `spend.posture` controls embedding cost gates. Use
`docs/operations/spend-controls.md` when deciding whether gates should enforce,
warn, or be disabled for a high-volume brain.

## Pacing and backlog work

Use pacing when the job is not one user-facing query but a large embed or sync
backlog that can contend with the job queue or a transaction-mode pooler.
Pacing is opt-in and cooperative:

```bash
gbrain embed --stale --pace
GBRAIN_PACE_MODE=balanced gbrain embed --stale
```

It caps in-flight DB writes, measures query latency in-band, and sleeps between
safe points rather than freezing the process mid-transaction. Do not replace it
with external `SIGSTOP`/`SIGCONT` wrapper scripts. v0.42.49.0 also defines
persistent `pace.mode`; in the current strict `config set` allowlist, persist it
with `gbrain config set pace.mode balanced --force` until `pace.mode` is
registered as a known key.

## Production choices

For production or shared-brain operation:

1. Pick the operating model and deployment topology first.
2. Pick the search mode based on downstream model tier, query volume, and
   tolerance for recall loss.
3. Use `search` for read-only context in agents by default.
4. Use `think` only where the workflow needs synthesized prose and citations.
5. Schedule `dream` or autopilot only after the operator approves cadence,
   provider keys, and cost boundaries.
6. Prefer ambient retrieval reflex or one-shot `volunteer_context` for agent
   push context. Use `watch` for transcript streams, and prefer Postgres when
   it must run concurrently with MCP serving.
7. Use `gbrain advisor` as a read-only operating review after install, upgrade,
   or handoff. Enable MCP advisor publication only when a thin client should be
   allowed to ask for that review.
