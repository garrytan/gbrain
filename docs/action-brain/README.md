# Action Brain

**Commitment tracking for WhatsApp-native operators.**

Your messages arrive. Commitments, follow-ups, and obligations scatter across threads. You stitch them together in your head, every day. Action Brain ingests that stream, extracts every commitment, classifies it (waiting on someone, owed by you, urgent, stale), and surfaces a morning brief so you don't drop loops. When a draft reply is needed, it writes one — then waits for you to approve before sending.

Built on top of [GBrain](../../README.md). Same database. Shared entity graph. Unified query surface.

---

## What you get

| Capability | What it means | Command |
|---|---|---|
| **Ingest** | Pull WhatsApp messages into the brain, extract commitments with an LLM, store as action items | `gbrain action ingest` |
| **Brief** | Morning priority brief: what's waiting on whom, what's overdue, what's owed by you | `gbrain action brief` |
| **Resolve** | Mark a commitment done, closed, or a false positive | `gbrain action resolve <id>` |
| **Draft** | Generate context-aware reply drafts for high-priority items | `gbrain action draft regenerate <item-id>` |
| **Confirm-send** | Review a draft, approve, and send via wacli. Never auto-sends | `gbrain action draft approve <id>` |
| **Entity linking** | Drafts pull context from GBrain pages (people, projects, history) | automatic in brief + draft |

**Trust invariants (non-negotiable):**
- No auto-send. Every outbound message requires your explicit approval.
- Owner-sanitized LLM input (control chars stripped, aliases bounded).
- Fail-closed on stale or degraded context — drafts are blocked rather than guessed.
- Recall gate in CI: extraction must hit ≥90% on the private gold set before ship.

---

## Prerequisites

You need this installed on your machine:

1. **bun ≥ 1.0** — runtime + package manager. `curl -fsSL https://bun.sh/install | bash`
2. **git** — to clone the repo.
3. **GBrain installed and initialized** — see the root [README](../../README.md). Two-second init, PGLite, no external DB needed.
4. **wacli** — the WhatsApp bridge that surfaces messages to the filesystem. Install instructions: [wacli repo](https://github.com/praveen-ks-2001/wacli) (or wherever your Hermes setup points). `wacli` must be on your PATH.
5. **An LLM API key** for extraction and drafting — OpenAI-compatible. Set `OPENAI_API_KEY` or configure the default model via env.

Optional but recommended:
- **Paperclip** if you want to run Action Brain under a full agent orchestration surface.
- **OrbStack / Docker** if you want to reproduce the CI pgvector suite locally.

---

## Install

```bash
git clone https://github.com/ab0991-oss/gbrain.git
cd gbrain
bun install
bun link                              # makes `gbrain` available on PATH
gbrain init                           # initializes local PGLite brain
```

Verify:

```bash
gbrain --version                      # should print 0.14.x or later
gbrain action --help                  # Action Brain subcommand tree
```

If `gbrain action` is missing, your install is on a pre-0.13 tag. Pull master.

---

## Setup

### 1. Environment

Create a local `.env` or export these in your shell (`~/.zshrc`). Not all are required at first run; defaults work for single-user local use.

```bash
# Core
export OPENAI_API_KEY="sk-..."                        # LLM for extraction + drafting
export BRAIN_DIR="$HOME/.gbrain"                      # where GBrain keeps PGLite + pages

# WhatsApp ingest (wacli)
export WACLI_STORE_DIR="$HOME/.wacli"                 # wacli's message store
export ACTION_BRAIN_WACLI_BUSINESS_STORE="$HOME/.wacli/business"
export ACTION_BRAIN_WACLI_PERSONAL_STORE="$HOME/.wacli/personal"

# Draft context bounds (tune if context fetches time out)
export ACTION_DRAFT_CONTEXT_PAGE_LIMIT=5              # how many GBrain pages to pull per draft
export ACTION_DRAFT_CONTEXT_MAX_CHARS=8000            # total context char budget
export ACTION_DRAFT_CONTEXT_THREAD_MESSAGE_LIMIT=20   # last N messages from the thread
export ACTION_DRAFT_CONTEXT_THREAD_FETCH_TIMEOUT_MS=5000
export ACTION_DRAFT_CONTEXT_PAGE_EXCERPT_MAX_CHARS=1500

# Draft generation / send
export ACTION_DRAFT_DEFAULT_MODEL="gpt-4o-mini"       # override per-draft with --model
export ACTION_DRAFT_DEFAULT_SEND_TIMEOUT_MS=30000

# Lock reclaim (concurrent ingest safety)
export ACTION_BRAIN_CHECKPOINT_LOCK_RECLAIM_DELAY_MS=30000
```

### 2. Point Action Brain at your WhatsApp store

wacli writes each conversation as a JSON blob under `WACLI_STORE_DIR`. Action Brain reads those through the pulse collector.

```bash
# Sanity check: wacli has synced something
ls "$WACLI_STORE_DIR"
# You should see conversation files. If empty, run `wacli sync` first.
```

### 3. Link your people and projects in GBrain

Action Brain is only as good as the entity graph behind it. The morning brief ranks items by who's involved. Make sure the people and projects you actually care about exist as GBrain pages.

```bash
# Quick example: create a person page for Sagar
cat > "$BRAIN_DIR/people/sagar.md" <<EOF
---
type: person
name: Sagar Patel
aliases: ["Sagar", "Vidyasagar"]
phone: "+91XXXXXXXXXX"
---

# Sagar Patel
Operating partner in DM Tin / KTM Tanzania. Coal + tin operator.
EOF

gbrain extract all                    # rebuild links from markdown → DB
```

Same pattern for projects: `$BRAIN_DIR/projects/ktm-tanzania.md`, `dm-tin.md`, etc.

### 4. First ingest

```bash
# Dry run: extract commitments from the last sync window, don't write yet
gbrain action ingest --timeout-ms 120000

# See what landed
gbrain action list
```

The first ingest on a large store takes a while. The extractor uses the gold-set gate (≥90% recall) and the owner-sanitizer — it will fail closed on malformed input rather than hallucinate.

### 5. Morning brief

```bash
gbrain action brief
```

That's the daily ritual. The brief shows:
- **Urgent today** — stuff with an explicit deadline inside 24h
- **Owed by me** — what you've committed to deliver
- **Waiting on** — who owes you and for how long
- **Stale** — items with no movement past the stale threshold

Each item has a link back to the source message for traceability.

---

## Daily workflow

### Morning

```bash
gbrain action brief                   # read your day
```

### While working

```bash
# Got a new commitment mid-day? Re-ingest the latest messages
gbrain action ingest

# Done something you committed to? Close it
gbrain action resolve act_abc123

# Extractor caught something that isn't actually an obligation? Mark false positive
gbrain action mark-fp act_abc123
```

### When a draft is needed

```bash
# Generate (or regenerate) a draft reply for a specific action item
gbrain action draft regenerate act_abc123 --hint "short, ask for the bill of lading"

# See what was drafted
gbrain action draft list --status pending
gbrain action draft show draft_xyz789

# Edit if needed
gbrain action draft edit draft_xyz789 --text "Got it. Can you send the BL by EOD?"

# Approve + send (goes through wacli, will not send without this step)
gbrain action draft approve draft_xyz789

# Or reject
gbrain action draft reject draft_xyz789 --reason "context was wrong — I'll handle directly"
```

**Every `approve` requires you personally.** There is no auto-send. If you want to batch-approve, you still call `approve` once per draft.

---

## CLI reference

### `gbrain action`

```
Usage: gbrain action <subcommand> [options]

Subcommands:
  list [--status S --owner O --stale]           List Action Brain commitments
  brief [--now <iso>] [--last-sync-at <iso>]    Morning priority brief
        [--timezone-offset-minutes <m>]
  resolve <id>                                   Mark an action item resolved
  mark-fp <id>                                   Mark as extractor false positive
  ingest [--messages-json <json>]               Extract and ingest commitments
         [--model <model>] [--timeout-ms <ms>]
  draft <subcommand>                             Draft reply management (see below)
```

### `gbrain action draft`

```
Usage: gbrain action draft <subcommand> [options]

Subcommands:
  list [--status <pending|approved|rejected|sent|send_failed|superseded>]
       [--action-item-id <id>]
  show <draft-id>
  approve <draft-id> [--timeout-ms <ms>]
  reject <draft-id> [--reason "..."]
  edit <draft-id> --text "..."
  regenerate <item-id> [--hint "..."]
```

Draft statuses progress: `pending` → `approved` → `sent` (happy path). On failure: `send_failed` (requires explicit re-approve on a fresh draft — never auto-retries). When you regenerate, the old draft becomes `superseded`.

---

## Scheduling (autonomous operation)

If you want Action Brain to pull messages and update the brief on its own:

### Via cron (simplest)

```cron
# Ingest every 15 minutes
*/15 * * * *  /Users/you/.bun/bin/bun run /path/to/gbrain/src/cli.ts action ingest >> ~/.gbrain/logs/ingest.log 2>&1

# Morning brief at 08:30 local
30 8 * * *    /Users/you/.bun/bin/bun run /path/to/gbrain/src/cli.ts action brief >> ~/.gbrain/logs/brief.log 2>&1
```

### Via GBrain Minions (agent-native)

If you already run GBrain with Minions, register the jobs through the standard `gbrain jobs` tooling. The action-brain collector + brief already emit minion-compatible job payloads. See the [Minions guide](../../docs/designs/MINIONS_AGENT_ORCHESTRATION.md).

### Via Paperclip (full agent orchestration)

Run Action Brain as an agent inside Paperclip with its own heartbeat cadence. That gives you: checkpoint resumption, executionPolicy stages for review gates, failure-mode retries, and the rest of the Git Factory discipline. See [Git Factory integration](../../docs/designs/action-brain/0.2.md).

---

## Troubleshooting

### `gbrain action ingest` hangs or times out

- Check `ACTION_DRAFT_CONTEXT_THREAD_FETCH_TIMEOUT_MS` — if wacli is slow, bump to 15000.
- Check `WACLI_STORE_DIR` is readable and has fresh message files.
- Run with `--timeout-ms 600000` for a full-history backfill.

### The extractor missed obvious commitments

- Verify your entity pages exist in `$BRAIN_DIR`. The extractor uses them as owner-grounding.
- Re-run `gbrain extract all` to refresh entity links.
- Check the recall gate: `bun test test/action-brain/gold-set.test.ts` — must be ≥90%. If it's failing, the extractor is regressing before you even look at your own data.

### A draft won't `approve` — says `send_failed`

- This is by design. Action Brain never auto-retries a failed send. You must `regenerate` to create a fresh draft version, then approve that one.
- Check wacli's own state: `wacli status`. A dead wacli produces silent send failures.

### A brief is missing an item I know is in a thread

- The stale-context sweep might have skipped it during a high-ingest window. Try `gbrain action brief --now <iso>` to re-run against a clean clock.
- Check `action_brief` logs for `sweep_starvation` warnings (the starvation-resistant cursor should prevent this — but logs will tell you if something went sideways).

### I accidentally marked the wrong item as false positive

Action items are never hard-deleted. Mark-fp sets a flag. To reverse it:

```bash
gbrain action list --status fp
# identify the id, then (no CLI yet — query directly)
gbrain query "UPDATE action_items SET status='open' WHERE id='act_abc123'"
```

(A proper un-mark-fp CLI is on the roadmap — 0.3.)

---

## Architecture snapshot

```
                 ┌──────────┐
                 │   You    │──────┐
                 └──────────┘      │ approve/reject drafts
                      │            │
                      │ reads      │
                      ▼            │
                 ┌──────────┐      │
                 │  Brief   │      │
                 └──────────┘      │
                      ▲            │
                      │ action_items + drafts
                      │            │
   ┌──────────────────┴────────────┴─────────────┐
   │              Action Brain (PGLite)            │
   │   action_items    action_drafts    history    │
   └──────────────────────────────────────────────┘
          ▲                    ▲                 ▲
          │ extract            │ context-source  │ send
          │                    │                 │
   ┌──────┴───────┐     ┌──────┴───────┐    ┌────┴─────┐
   │  Extractor   │     │   GBrain     │    │  wacli   │
   │  (LLM)       │     │  (entities)  │    │  (send)  │
   └──────────────┘     └──────────────┘    └──────────┘
          ▲
          │ messages
   ┌──────┴───────┐
   │  wacli /     │
   │  Pulse       │
   └──────────────┘
```

- **Pulse collector** reads messages from wacli's store. Deterministic, checkpointed, locked per wacli-store so concurrent collectors can't double-read.
- **Extractor** calls an LLM with owner-sanitized input and a strict JSON schema. Failures are fail-closed. Counters feed the morning brief runtime metrics.
- **action_items / action_drafts** — PGLite tables inside the GBrain DB, not separate. Same pages, same query surface.
- **Context source** for drafts — bounded page pull from GBrain + last N thread messages, with timeout + stale-sweep starvation resistance.
- **wacli send** — only invoked through `draft approve`. Idempotent via approval-send correlation window. Failures flip the draft to `send_failed` without auto-retry.

---

## What's shipped (MVP status vs DESIGN.md)

- ✅ **MVP 0.1a** — Commitment tracking engine
- ✅ **MVP 0.1b** — Pulse auto-ingest + collector hardening
- ✅ **MVP 0.1c** — Reliability + observability (retry/backoff, audit trail, counters, recall gate, 48h e2e, entity linking)
- ✅ **MVP 0.2** — Suggested responses + confirm-before-send

**In flight or planned:**

- 🔄 **0.3 upstream catchup** — absorb upstream GBrain Knowledge Runtime (Resolver SDK, BrainWriter, Budget, typed graph edges)
- 🔄 **0.3 partner proxy** — multi-channel approval via Telegram + WhatsApp, shared read-only view for partners
- 🔄 **0.3 distribution Phase 2** — public OSS release, bun/npm install, documented setup
- 🔄 **Integrated assistant** — end-to-end loop with GBrain + Action Brain + OpenClaw + Hermes working in sync

See the DESIGN doc: [`docs/designs/action-brain/DESIGN.md`](../designs/action-brain/DESIGN.md).

---

## License

MIT (same as upstream GBrain). See [`LICENSE`](../../LICENSE).
