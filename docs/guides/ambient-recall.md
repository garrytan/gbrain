# Ambient recall — placing retrieval at session boundaries

Long-lived agent harnesses (your OpenClaw, Hermes, Codex, Claude Code) get the
most value from the brain not on every message, but at the moments where a fresh
question rarely fires on its own: **session start, right after compaction, and
on heartbeats.** This guide is the Pareto frontier of where to place each verb.

The bottleneck for a long-lived agent is not retrieval quality — the corpus
answers well when asked. It is **placement**: the misses come from moments when
no question fires. Two frozen verbs close that gap with 2-3 deterministic calls
per session instead of per-message overhead.

This guide is the READ side of ambient memory. The WRITE side — opt-in
ambient writeback, where agents save directly-stated user facts during
ordinary conversation — is [ambient-writeback.md](./ambient-writeback.md).

## The frontier — which verb goes where

| Moment | Call | Why | Cost |
|---|---|---|---|
| Any entity-bearing message | `entity(name)` | Zero-LLM, p99 < 100ms. Safe to run synchronously almost anywhere. | negligible |
| **Session start** | `context_pack(entities, budget_tokens)` | Warm the thread's 1-3 standing entities before the first message. | zero-LLM, sub-second |
| **After compaction** | `context_pack(entities, budget_tokens)` | Rehydrate the verbatim detail the summary dropped. | zero-LLM, sub-second |
| **Heartbeat / periodic wake** | `delta(session_id, budget_tokens)` | "What changed since my last wake" in O(changes), deduped. | zero-LLM, sub-second |
| Explicit memory question | `recall(query \| entity, budget_tokens)` | The budget-packed read for "what do we know that we SAVED about X". | sub-second (+1 embedding if `query`) |
| Answer needs cross-page reasoning | `synthesize(question)` | LLM-backed. **Never** on a hot or ambient path. | seconds-to-minutes, $$ |

Observed shape: per-message retrieval beyond `entity` cards adds latency faster
than insight; session-start packs and post-compaction rehydration are nearly
pure win. See the per-verb latency table in
[`docs/protocol/MEMORY_VERBS_v1.md`](../protocol/MEMORY_VERBS_v1.md#latency-classes-per-verb).

## Three integration surfaces

- **Pull (works everywhere, including Codex + Postgres/Supabase):** the harness
  calls `context_pack` / `delta` over MCP (they are on `--surface verbs`) or the
  CLI (`gbrain context-pack`, `gbrain delta`) at the boundary and injects the
  returned `text` (or renders the structured arms). This is the portable path —
  no hooks required. It is the primary path for Codex and opencode (no wired hooks) and
  for Postgres brains (which have no local IPC socket).
- **Push (PGLite + Claude Code):** the bundled hook framework fires
  automatically at `SessionStart` (injects a warm pack — including the
  post-compaction re-entry, `source=compact`, which also carries the banked
  `## Compaction checkpoints` links) and `PreCompact` (banks the window's
  standing entities for that rehydration pack AND spools the
  since-last-boundary window as a durable corpus segment that serve harvests
  into facts + `brain://` links — see
  [`checkpoint-compaction.md`](./checkpoint-compaction.md)). Heartbeat deltas
  are the PULL path — there is deliberately no push heartbeat; call `delta`
  per the HEARTBEAT cadence table.
- **Engine-internal (OpenClaw):** the context engine runs the checkpoint lane
  itself — `compact()` banks the boundary segment before delegating and
  `assemble()` injects the banked checkpoint block (engine contract 0.3.0;
  no hooks, no recipe — see
  [`checkpoint-compaction.md`](./checkpoint-compaction.md)).

## Visibility — world-only by default

A pack is injected into an agent context window that may be logged or synced to a
cloud model, so **every arm is world-visibility by default.** To pull private
facts in, pass `include_private` — and it is honored ONLY for trusted-local
callers (`remote === false`, i.e. the CLI/hook path). A remote MCP caller never
widens, even if it asks (fail-closed). When it does widen, all arms widen
together, so a pack is never a mix of private facts beside world-stripped
synopses.

## Budgets

Every pack/delta call takes `budget_tokens`. The server packs highest-priority
arms first (cards → facts for packs; pages → facts for deltas) and reports
`budget_used` + `dropped_count`; the injectable `text` field is rendered from
the packed sets, so it honors the same budget the structured arrays report. It
never trims client-side — you always know what was left out (`dropped_count`,
and `has_more` on deltas). Pick a budget to fit the boundary: a session-start
pack can afford more than a heartbeat delta.

## Heartbeat cursor + dedup

Pass a stable `session_id` to `delta` and the brain keeps a per-session cursor:
the first wake establishes it, each wake advances it. Dedup is **cursor-based**
— a delivered page reappears only if it changes again after delivery (and then
it should). Delivery is **at-least-once**: pages arrive oldest-first, and when
a budget or the fetch limit drops some, the response sets `has_more: true` and
the cursor advances only to the newest *delivered* page, so the tail surfaces
on the next wake — nothing is silently lost. With no `session_id` you can still
pass an explicit `since` for a stateless delta. The cursor is namespaced per
caller (`(source_id, client_id, session_id)`; authenticated remotes use their
client id, auth-less remotes share a `remote` namespace, and `local` is
reserved for the trusted CLI/hook lane), so a remote harness can never read or
advance the local lane's cursor. Idle session cursors are garbage-collected
after **7 days** — a wake on an expired session re-establishes the cursor at
now and returns an empty delta, so a harness returning from a long sleep
should run one stateless `since`-based catch-up first.

## Example — a cold session start (pull)

```bash
gbrain context-pack --entities "acme-example,alice-example" --budget-tokens 4000
```

Returns entity cards + open threads + hot facts, budget-packed, world-only. Inject
the `text` field into the model's context before the first user message.
