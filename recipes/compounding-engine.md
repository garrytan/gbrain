---
id: compounding-engine
name: Compounding Engine
version: 0.1.0
description: |
  Autonomous nightly brain improvement loop that complements `gbrain dream`. While
  the dream cycle runs deterministic maintenance (lint, backlinks, sync, extract,
  embed, orphans), this engine adds a 7th LLM-driven phase: semantic analysis
  that detects opportunities the deterministic phases miss — people mentioned
  without their own page, knowledge gaps (companies/concepts referenced 3+ times
  with no slug), concept duplication via embedding similarity, synthesis
  opportunities (3+ originals on same theme → consolidation concept), and archive
  candidates (90+ days unused). Auto-applies in categories with confidence >0.70,
  learns from your reverts to update per-category confidence over time. After
  30+ cycles, the engine knows your preferences and only acts where you've
  consistently approved its proposals.
category: compound
requires: []
secrets: []
health_checks:
  - type: command
    argv: ["test", "-x", "$HOME/.openclaw/skills/gbrain/compound/run.sh"]
    label: "compound/run.sh installed"
  - type: command
    argv: ["test", "-f", "$HOME/.openclaw/skills/gbrain/compound/learning.json"]
    label: "learning.json initialized"
setup_time: 5 min
cost_estimate: |
  $0/mo if used with Claude Code CLI subscription (`claude -p` from cron uses
  your existing Max plan). Optional fallback to Anthropic API key for
  agents-without-Max-CLI environments — ~$0.30/month at standard nightly cadence
  with Haiku 4.5 for analysis.
---

# Compounding Engine: 7th-phase semantic improvement to dream cycle

## Why this recipe exists

`gbrain dream` (existing) executes 6 deterministic phases each night: lint,
backlinks, sync, extract, embed, orphans. These are excellent at maintaining
the brain at a structural level. But they share a property: they **do not
create new pages**, **do not consolidate ideas**, **do not detect semantic
patterns** that emerge from the LLM-readable text content.

Examples of what the deterministic dream cycle misses:

- A name like "Mike Shapiro" mentioned 4 times across 3 originals, no
  `people/mike-shapiro` page exists. The dream cycle's `orphans` phase finds
  pages without backlinks, but it does NOT detect *entities mentioned in
  page text without a corresponding page*.
- Three originals about "remote-first hiring tradeoffs" written across two
  weeks. None of them references the others. There's no `concepts/remote-first-hiring`
  page consolidating the thesis. The dream cycle's `extract` phase pulls
  links and timeline entries from existing structure, but does NOT propose
  new structure.
- A `projects/old-thing` last touched 90 days ago, never queried, never
  linked from anywhere new. Pure dead weight. The dream cycle's `orphans`
  flags it but does not propose archival.

This recipe adds a **7th phase** that runs *after* dream cycle and uses an
LLM to propose concrete improvements. Auto-applies high-confidence
proposals, journals every change, learns from user reverts.

The result, per Garry's tagline: "the brain is smarter than when I went to
sleep" — but extended to *structural growth*, not just maintenance.

## IMPORTANT: Instructions for the Agent

**You are the installer. Follow these steps precisely.**

This recipe is a **complement** to `gbrain dream`, not a replacement. Both
should run nightly, with this engine running ~30 minutes after the dream
cycle to avoid race conditions on the database.

### Step 1: Install scripts

```bash
mkdir -p ~/.openclaw/skills/gbrain/compound/{prompts,journal,backups}

# Copy the bundled scripts:
cp compounding-engine/run.sh ~/.openclaw/skills/gbrain/compound/run.sh
cp compounding-engine/morning-report.sh ~/.openclaw/skills/gbrain/compound/morning-report.sh
cp compounding-engine/prompts/analyze.md ~/.openclaw/skills/gbrain/compound/prompts/analyze.md
cp compounding-engine/learning.json ~/.openclaw/skills/gbrain/compound/learning.json

chmod +x ~/.openclaw/skills/gbrain/compound/*.sh
```

### Step 2: Verify dream cycle exists

The compounding engine assumes `gbrain dream` runs nightly. Verify:

```bash
gbrain --help | grep -i dream
crontab -l | grep -i dream
```

If `gbrain dream` is not yet scheduled, install it first per
`docs/guides/cron-schedule.md`. The compounding engine should run **30
minutes after** the dream cycle.

### Step 3: Schedule via cron

```bash
# Two cron entries — analysis at 30 min after your dream cycle, report at morning
(crontab -l 2>/dev/null ; cat <<EOF) | crontab -
30 10 * * * bash \$HOME/.openclaw/skills/gbrain/compound/run.sh run >> \$HOME/.gbrain/logs/compound.log 2>&1
0 15 * * * bash \$HOME/.openclaw/skills/gbrain/compound/morning-report.sh >> \$HOME/.gbrain/logs/compound.log 2>&1
EOF
```

Adjust hours to your timezone — the example assumes UTC and runs at 03:30 Hermosillo (UTC-7).

### Step 4: Configure Telegram (optional but recommended)

Morning report uses your existing OpenClaw bot if configured at
`~/.openclaw/openclaw.json` → `channels.telegram.botToken` + `chatId`.
If not, the engine still runs and writes to journal — only the
notification step is skipped.

### Step 5: First run — recommended dry-run

```bash
bash ~/.openclaw/skills/gbrain/compound/run.sh dry-run
```

Generates proposals **without applying anything**. Review the journal output
to validate the LLM is producing reasonable suggestions for your brain.
Iterate the prompt at `compound/prompts/analyze.md` if needed before
enabling auto-apply.

### Step 6: Verify

```bash
test -x ~/.openclaw/skills/gbrain/compound/run.sh && echo "scripts installed"
test -f ~/.openclaw/skills/gbrain/compound/learning.json && echo "learning state initialized"
```

## How it works

```
┌────────────────────────────────────────────────┐
│ 03:00 Hermosillo — gbrain dream (existing)     │
│   lint → backlinks → sync → extract → embed → orphans │
└──────────────────┬─────────────────────────────┘
                   ↓
┌────────────────────────────────────────────────┐
│ 03:30 Hermosillo — compound run (this recipe)  │
│   1. Backup brain state                         │
│   2. Read pages last 24h, learning.json        │
│   3. claude -p with analyze.md prompt          │
│   4. JSON proposals (7 categories)              │
│   5. Auto-apply where category confidence ≥0.70│
│   6. Journal every change with revert ID       │
└──────────────────┬─────────────────────────────┘
                   ↓
┌────────────────────────────────────────────────┐
│ 08:00 Hermosillo — morning report              │
│   Telegram silent push: applied/skipped/errors │
└────────────────────────────────────────────────┘
```

## 7 categories detected

1. **people_orphans** — names in compiled_truth 2+ times without `people/<slug>`
2. **page_orphans** — pages with 0 in/out links AND >7 days old
3. **knowledge_gaps** — companies/concepts referenced 3+ times without page
4. **concept_duplication** — originals with embedding cosine sim >0.92
5. **incomplete_pages** — `LENGTH(compiled_truth) < 100` chars
6. **archive_decay** — 90+ days no updates AND 0 hits in `mcp_request_log`
7. **synthesis_opportunities** — 3+ originals on same theme → propose `concepts/<theme>`

Each starts with prior confidence (0.40-0.80). Reverts lower it; sustained
auto-applies without revert raise it. Below `auto_apply` threshold (default
0.70), proposals are logged but not applied — manual approval required.

## Confidence learning loop

After 30+ cycles, the agent operates on calibrated category-level
confidence reflecting *the user's* preferences:

```
people_orphans      ████████████░░  0.92  applied=12  reverted=1
page_orphans        ███████████░░░  0.85  applied=23  reverted=3
knowledge_gaps      ██████████░░░░  0.78  applied=11  reverted=2
synthesis_opps      █████░░░░░░░░░  0.40  applied=2   reverted=3  ← below threshold, log-only
```

This is the engine's way of "knowing" the user. Garry's brain prefers
auto-creating people pages but is conservative about consolidation;
another user might be the inverse. Both end up with confidence vectors
that reflect their actual editorial preferences.

## Subcommands (when wired into a skill)

If you have `gbrain` skill installed (e.g. `durang/gbrain-skill`), it
exposes the engine via `/gbrain compound`:

| Command | Effect |
|---|---|
| `/gbrain compound run` | Manually trigger a cycle (cron does this nightly) |
| `/gbrain compound dry-run` | Show proposals without applying |
| `/gbrain compound status` | Confidence per category + lifetime stats |
| `/gbrain compound history` | Last 10 cycles' journals |
| `/gbrain compound revert <id>` | Queue a specific change for revert |

## Composability

This recipe is intentionally minimal — it composes with the existing
gbrain primitives:

- Reads pages via `psql $DATABASE_URL` (no special API)
- Writes via `gbrain put-page` and `gbrain add-link` (existing CLI)
- Audits via `mcp_request_log` (existing schema)
- Backs up to local filesystem (existing pattern)

No new database schema, no new dependencies, no new infrastructure.

## When to skip this recipe

- You don't have a Claude Code subscription (or willingness to use API key
  for ~$0.30/month equivalent). The engine requires LLM access.
- You prefer fully-deterministic operations and don't want LLM agency in
  your brain. The engine actively creates pages and modifies the graph.
- Your brain is <100 pages — the patterns it detects need volume to
  emerge meaningfully.

## See also

- [`docs/guides/operational-disciplines.md`](../docs/guides/operational-disciplines.md) — DISCIPLINE 5 (nightly dream cycle)
- [`src/core/cycle.ts`](../src/core/cycle.ts) — `runCycle()` primitive that the dream cycle uses
- [`recipes/claude-code-capture.md`](claude-code-capture.md) — companion recipe (PR #481) for ambient capture in Claude Code CLI
