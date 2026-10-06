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
arms first (cards → facts for packs; pages → facts for deltas — a delta never
drops threads, their lines are reserved ahead of pages and facts),
costing each item as the line it renders to and reserving the envelope +
section headers up front, and reports `budget_used` (the token estimate of
`text`) + `dropped_count`; the injectable `text` field is rendered from the
packed sets, so it never exceeds the budget the structured arrays report. It
never trims client-side — you always know what was left out (`dropped_count`,
and `has_more` on deltas). Pick a budget to fit the boundary: a session-start
pack can afford more than a heartbeat delta.

## Heartbeat cursor + dedup

Pass a stable `session_id` to `delta` and the brain keeps a per-session cursor:
the first wake establishes it, each wake advances it. Dedup is **cursor-based**
— a delivered page reappears only if it changes again after delivery (and then
it should). Delivery is **at-least-once, per arm**: pages arrive oldest-first by
`(updated_at, slug)` and facts oldest-first by `(created_at, id)`, each arm with
its own cursor. When a budget or a fetch limit drops some, the response sets
`has_more: true` and each arm advances only through what it *delivered*, so the
tail surfaces on the next wake. An arm whose read failed (or never finished
before a deadline) does not advance at all: the response carries
`degraded_reason` and a `delta_incomplete` notice whose fix is to retry the same
call in about 30 seconds (`fix.next: wait`); after three consecutive incomplete
wakes on one session the fix becomes `report` (tell the user, run
`gbrain doctor --json`). Neither arm advances past `now() - 2 s`, so a row
delivered within the last two seconds can arrive once more on the next wake.
Thread events are best-effort: they follow the pages' time cursor and are never
budget-dropped. With no `session_id` you can still run a stateless delta:
pass `since` on the first call and `next_cursor.cursor` afterwards. The cursor is namespaced per
caller (`(source_id, client_id, session_id)`; authenticated remotes use their
client id, auth-less remotes share a `remote` namespace, and `local` is
reserved for the trusted CLI/hook lane), so a remote harness can never read or
advance the local lane's cursor. Idle session cursors are garbage-collected
after **7 days** — a wake on an expired session re-establishes the cursor at
now, returns an empty delta and says so in an info notice, so a harness
returning from a long sleep should run one stateless `since`-based catch-up
first (the replay recipe below).

**Guarantee, stated precisely.** Rows are stamped with their transaction's
start time. A transaction that commits more than two seconds after it started
can be passed by an empty wake that advanced the cursor in the meantime; every
other row reaches the session at least once. A failed session-state read is
never treated as a new session: delta refuses with `unavailable`
(`reason: session_state`) and keeps the checkpoint, and a failed state write
adds `session_state` to `degraded_reason` while the response still carries the
stateless `next_cursor`.

## Replay after a degraded wake

If a response carried `degraded_reason`, nothing was skipped: the next wake
re-reads the same window. To read that window right away (or to catch up after
a long sleep), replay statelessly from that response's `since`, without
`session_id`, so the session cursor is not moved:

1. Call `delta` with the same `entities` (and `include_private`, if used) and
   `since` set to the degraded response's `since`. Do not pass `session_id`.
2. Read `pages`, `facts` and `threads`; dedupe pages by `slug` and facts by `id`.
3. While `has_more` is true or `degraded_reason` is present, call again with
   `cursor` set to the previous response's `next_cursor.cursor` (wait about 30
   seconds first if it was degraded).
4. Stop when `has_more` is false and no `degraded_reason` remains.

MCP payloads:

```json
{"tool": "delta", "arguments": {"since": "2026-08-11T00:00:00.000000Z", "entities": "acme-example"}}
{"tool": "delta", "arguments": {"cursor": "<next_cursor.cursor from the previous response>", "entities": "acme-example"}}
```

CLI equivalent:

```bash
gbrain delta --since 2026-08-11T00:00:00.000000Z --entities acme-example --json
gbrain delta --cursor "$NEXT_CURSOR" --entities acme-example --json
```

Expected result: the loop ends with `has_more: false` and no `degraded_reason`;
every page and fact changed after `since` has appeared at least once. A failure
looks like `"degraded_reason": "facts"` with a `delta_incomplete` notice: wait
and repeat the same call. Verify with one more call from the last
`next_cursor.cursor`: it returns empty arrays.

Replay returns the data the brain holds now (current page versions, active
facts), not historical page versions. The session cursor columns added for the
per-arm cursor start from each session's last wake, so gaps skipped before the
upgrade are not recoverable by the session itself; replay from an older `since`
reads them. `next_cursor.since` + `since_slug` still work for older clients:
they are conservative (they may re-deliver, they never skip facts), and a
legacy caller that reaches more undelivered facts at one timestamp than the
fetch limit gets `delta_cursor_upgrade_required`, whose fix is the same call
with `cursor`. Each response also carries `start_cursor`-equivalent detail in
`cursor_arms` (each arm's start and next keyset) for audit.

## Example — a cold session start (pull)

```bash
gbrain context-pack --entities "acme-example,alice-example" --budget-tokens 4000
```

Returns entity cards + open threads + hot facts, budget-packed, world-only. Inject
the `text` field into the model's context before the first user message.
