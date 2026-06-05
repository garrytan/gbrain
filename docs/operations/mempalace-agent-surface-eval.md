# MemPalace Agent-Surface Evaluation

## Purpose

Use this runbook when evaluating MemPalace, or a similar external agent-memory
system, for GBrain-adjacent agent surfaces such as Claude Code, Codex, Hermes,
OpenClaw, or app-level agents.

This is an evaluation lane, not an adoption lane. The default posture is a boxed
sidecar: no global hooks, no profile edits, no MCP config changes, and no writes
into canonical GBrain/Hermes/Codex state until a bounded eval proves the tool
wins a real job.

## Source Receipts

The initial review on 2026-06-05 inspected the MemPalace repository directly
from `https://github.com/MemPalace/mempalace` at develop commit `02b8753`
(`version = "3.3.6"` in `pyproject.toml`).

Relevant surfaces:

- `README.md` — product claim, install path, benchmark framing, hooks, MCP.
- `docs/HISTORY.md` — benchmark corrections, retractions, impostor-domain notice.
- `benchmarks/BENCHMARKS.md` — retrieval methodology and caveats.
- `.claude-plugin/` — Claude plugin metadata, hooks, MCP declaration.
- `.codex-plugin/` — Codex plugin metadata, hooks, MCP declaration.
- `mempalace/hooks_cli.py` — Stop/PreCompact/session-start behavior.
- `mempalace/mcp_server.py` — MCP tool surface and write-ahead logging.
- `docs/rfcs/002-source-adapter-plugin-spec.md` — source-adapter contract.

Do not rely on marketing copy alone. Re-read these files, or the current
upstream equivalents, before changing any local integration.

## Default Decision

Do not adopt unless a future eval proves a narrow job that existing
GBrain/current memory cannot do.

MemPalace is not an agent-surface tool the operator needs to remember. By
default, agents should ignore it. If an idea from MemPalace is useful, convert
that idea into an owned GBrain/Hermes/Codex implementation task with a receipt.

The strongest product idea is simple and testable: store conversation/project
text verbatim, then retrieve semantically without an LLM deciding what to keep.
That makes it a good benchmark challenger for transcript recall. It does not
make it safe to wire into every agent surface.

Latest boxed eval receipt:
[`docs/operations/mempalace-boxed-eval-2026-06-05.md`](./mempalace-boxed-eval-2026-06-05.md).

## Ownership Boundaries

- GBrain owns durable retrieval, source routing, and source-aware evals.
- Hermes owns profile/runtime behavior.
- Claude/Codex plugins own their own hook/plugin config.
- Agent memory owns operating preferences and workflow defaults.
- The current session owns immediate task state.
- External tools under review own only their isolated sandbox data.

Do not let an eval tool become a second control plane. If a fact belongs in a
repo, profile, brain source, or runtime log, write it there first and let GBrain
index it afterward.

## Evaluation Plan

### 1. Box the install

Use a temporary palace and a disposable Python tool environment. Do not install
global hooks or mutate live Claude/Codex/Hermes configs during the first pass.

Allowed first-pass setup shape:

```bash
tmpdir="$(mktemp -d)"
export MEMPALACE_PALACE_PATH="$tmpdir/palace"
uv tool install mempalace
```

If the tool requires `~/.mempalace`, stop and classify that as eval friction
before accepting it.

### 2. Select the corpus

Use a small non-sensitive transcript slice first:

- 20 to 50 old Claude/Codex sessions.
- No secrets.
- No live customer, personal-contact, credential, or paid-account material.
- Prefer sessions whose outcomes are already known from repo receipts.

### 3. Build the query set

Create 20 real recall questions. Include:

- decisions made across long sessions
- error text or command output that should be recoverable verbatim
- follow-up tasks that were resolved later
- repo-boundary questions
- at least three negative controls where the right answer is "not found"

Keep the query set outside the tool being evaluated.

### 4. Run the comparison

Compare at least three surfaces:

- MemPalace search over the boxed corpus.
- GBrain search/query over the relevant source.
- Current curated memory or session-summary lookup when applicable.

Score each query:

- hit quality
- cited/source specificity
- verbatim recovery
- latency
- noise
- privacy risk
- operator friction

### 5. Decide the narrow adoption path

Adopt only if MemPalace wins a job that GBrain/current memory does not already
handle well.

Candidate ideas to mine into owned work:

- source-adapter design
- hook timeout/silent-save safety
- old-session recall eval harnesses

Non-wins:

- "another memory store might be useful"
- "the benchmark numbers are impressive"
- "the plugin installed successfully"
- "the agent liked the metaphor"

## Hard No Until Proven

Do not enable any of these during the first eval:

- global Stop hooks
- global PreCompact hooks
- MCP write tools on live agent surfaces
- automatic diary writes from live agents
- knowledge-graph writes from live agents
- delete/update drawer tools
- Hermes profile edits
- Codex or Claude user-scope plugin installation
- migration of canonical GBrain content into MemPalace

## Proof Gates

The eval is not complete until these receipts exist:

- exact upstream commit or release inspected
- exact local install method recorded
- boxed palace path recorded
- corpus size and source paths recorded
- query set preserved outside the evaluated tool
- comparison score table completed
- current `git status --short --branch` captured for any repo touched
- final decision classed as adopt / reject / defer / do-not-adopt

If any proof gate is missing, call the result not verified yet.

## Goal Shape

When setting a session goal for this lane, keep it bounded:

> Run a boxed, non-global MemPalace evaluation against a small non-sensitive
> transcript corpus, compare it with GBrain/current memory on real recall
> queries, and document an adopt/reject/do-not-adopt decision without mutating
> live agent surfaces.

Once that goal is active, normal implementation can run at medium/high effort.
Return to extra-careful planning only if the work crosses a global config,
runtime, hook, profile, credential, or cross-repo write boundary.
