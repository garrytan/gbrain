# Agent Bootstrap — Product Design (normative for scope & sequencing)

**Status:** APPROVED (product review, 3 adversarial rounds; CEO review; eng review —
0 unresolved decisions). Implementation source of truth:
[AGENT_BOOTSTRAP_PLAN.md](AGENT_BOOTSTRAP_PLAN.md).

## Problem

Agent platforms (OpenClaw, Hermes) deliver the full personal-agent experience —
scheduled work, skill files, SOUL.md identity, persistent memory — but setting one up
means deploying a server, wiring API keys, and paying raw token prices. Meanwhile
nearly everyone already runs Claude Code or Codex, both subsidized by subscriptions,
both capable of executing an install protocol themselves.

**The feature:** a paste-in install that adds memory + skills + identity +
session-triggered schedules + knowledge persistence to a private GitHub repo,
mimicking the agent-platform experience on the desktop apps people already have.
"Just use your local harness as your agent."

## Target surfaces & order

| Surface | In v1? | Order | Per-turn context seam | Persistence (write) seam |
|---|---|---|---|---|
| Codex in ChatGPT desktop | YES | 1st | spike exit question #2 | spike exit question #1 (blocking); fallback: mandated MCP writes + end-of-session sweep |
| Codex CLI | YES | with 1st | AGENTS.md pull protocol + `volunteer_context` | mandated MCP write ops |
| Claude Code desktop | YES | 2nd | hooks: SessionStart / UserPromptSubmit via serve IPC | SessionEnd hook: transcript ingest + scan-gated push |
| Claude Code CLI | YES | with 2nd | same hooks | same hooks |

The wedge is NOT platform feature-parity on day one. It is: paste → interview → an
agent that knows who it is and who you are → recalls what you told it in the next
session → visibly compounds during week one.

## The repo format (the contract)

A private GitHub repo is the product artifact — the agent's portable body:

- **Manifest:** `agent.json` (`format_version: 1`, provisional; `initialized`
  sentinel distinguishes a template clone from a bootstrapped workspace).
- **Identity:** SOUL.md, USER.md, MEMORY.md, AGENTS.md, CLAUDE.md, HEARTBEAT.md,
  ACCESS_POLICY.md, GITHUB.md — rendered ONLY from interview answers, never invented.
- **Content:** `brain/` (the gbrain source), `memory/` (daily notes), `skills/`,
  `state/` (committed: interview.json, portable mcp.json; local-only files gitignored).
- **Compatibility promise:** hosted gbrain mounts `format_version: 1` repos natively;
  compatibility is a test against this spec.

## Premises (all settled)

1. **Free desktop tier of the hosted ladder** — the desktop ceiling (laptop asleep =
   agent asleep; data outgrows the disk) is the graduation mechanic to hosted gbrain.
2. **One agent-body format, two doors.** Portability up the ladder is moat #1.
3. **Awake-when-you-are is the honest desktop contract.** Session-triggered schedules
   (jobs run at turn/session boundaries while the harness is open); true 24/7 crons
   are hosted-tier, stated in-product.
4. **Day-one-empty-brain is the #1 churn risk.** Magic moment with zero corpus
   (interview → next-session recall) + fast ramp (file import; connector ingest v1.1).
5. **Wire-level truth before build:** a clean-machine spike gates door 1 (write-seam
   pass bar: 0 durable-write failures in 20 sessions over ≥3 days, else extend to 50).
6. **The graph is moat #2:** v1 exercises entity extraction, backlinks, and
   graph-aware recall; verify enforces a graph floor.
7. **Keyless mode is first-class:** the harness agent IS the subsidized LLM — with
   zero API keys, memory is agent-authored through write ops, search is keyword-only,
   and the magic moment still passes. One optional key unlocks embeddings +
   auto-extraction.

## Build order (one cathedral PR; size trip-wire: split at build order 2 if PR is
open >10 days from first code commit)

0. **Spike + quota gate** (manual, gates door-1 ship; per-harness quota measured; a
   p90 day must fit ≤10% of weekly subscription quota or schedule scope is cut).
1. **Shared body + engine machinery:** `gbrain bootstrap` family, templates, format
   spec, secret-scan-gated persistence, verify, uninstall (v1 via CEO-review
   expansion; receipt-keyed scope per the PLAN's CX2-12).
2. **Codex door ships first** (runbook variant + approvals preflight + capability
   probe; CLI path not spike-gated).
3. **Claude Code door:** hooks, IPC turn_context, transcript ingestion, greeting
   digest, schedule mechanism.
4. **Graduation seam, desktop half:** format spec + documented upgrade path (advisor
   nudge ships with the hosted mount in v1.1).

## Out of scope for v1

| Deferred | Lands | Why |
|---|---|---|
| Connector-driven ingest (email/calendar) | v1.1 (keyed to probe) | unverified host capability |
| Hosted mount + "outgrowing this laptop" nudge | v1.1 together | never point at a destination that can't accept the repo |
| `serve --attach` (simultaneous multi-harness) | fast-follow | v1 documents one-live-serve politely |
| Codex `notify` transcript sweeper | fast-follow | mandated MCP writes cover v1 |
| Windows (named-pipe IPC) | deferred | v1 = macOS + Linux |
| Networked Docker paste-flow e2e | fast-follow | offline container e2e covers 80% at 20% of the flake |
| `gbrain quota` meter command | TODOS | measurement ships as script+doc; productize when per-harness token counting is proven |
| True 24/7 crons on desktop | never | hosted-tier by design |

## Success criteria

- **TTFM ≤15 min** paste→verified install, excluding first-run toolchain downloads
  (published separately); every human action counted.
- **Magic moment, deterministically:** verify asserts an interview fact is retrievable
  through the agent's own MCP path; fresh-session end-to-end is a scripted human
  confirmation. Must pass keyless.
- **Pilot tests:** a non-developer pilot completes the door-1 install unaided and
  still uses it in week two; a developer completes the door-2 README install ≤10 min
  with a week-two recall check.
- **Graph floor:** ≥1 entity extracted, ≥1 backlink resolved, one edge-only query
  answered — via the real MCP write path.
- **Ladder proof:** a desktop-grown repo validates against `format_version: 1`.
- **Honesty checks:** quota number published; desktop contract stated in-product;
  door 1 demotes to documented-beta on its trigger rather than shipping flaky.

## Distribution

Paste block + tag-pinned runbook (`BOOTSTRAP_FOR_AGENTS.md`, fetched at the
`latest-stable` ref — advanced by the release job only after assets publish, so
published copies never rot); optional GitHub template repo (generated at release from
the same renderer); binary via `bun install -g github:garrytan/gbrain#latest-stable`
(never npm). The paste block lives in the README's `## Install` section, as
per-harness subsections ordered "For Codex — the recommended first step" → "For
Claude Code" → "For OpenClaw or Hermes" (the 2026-08-09 ordering decision, recorded
in the PLAN's artifact table). `INSTALL_FOR_AGENTS.md` remains the paste path for
agent platforms and lives inside the OpenClaw/Hermes subsection.

## Threat model (v1 summary)

Tag-pinned fetch + version-stamp skew check + runbook phase allowlist; secret-scan
gates every commit AND corpus write (loud block, per-finding override); repo privacy
verified via API after create; hooks in gitignored local settings with a kill switch;
interview answers rendered as fenced data (never instructions) with escaping and
caps; uninstall keyed to a machine-local receipt, never deletes a brain it didn't
create; provider-policy drift acknowledged as residual risk — posture: measured
sustainable load, no absent-user background burn, portable body as the exit plan.
Full posture: `docs/guides/bootstrap.md`.
