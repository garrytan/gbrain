---
name: context-audit
version: 1.0.0
description: |
  Token-hygiene audit of the always-loaded context stack — CLAUDE.md,
  AGENTS.md, auto-memory MEMORY.md, and the bootstrap-rendered identity files
  (SOUL.md, USER.md, ACCESS_POLICY.md, HEARTBEAT.md) or their harness
  equivalents. Finds redundancy, contradictions, stale content, compression
  candidates, and skill-extraction candidates; produces a ranked action list
  sorted by token savings with a risk class per finding. REPORT-ONLY: this
  skill never edits any audited file. Recommendations for bootstrap-rendered
  files target the interview answer bank / templates, never the rendered
  output. Judging routes through `gbrain eval cross-modal` (single cheap
  model by default; full multi-model panel is explicit opt-in).
triggers:
  - "context audit"
  - "context diet"
  - "system prompt audit"
  - "prompt compression"
  - "reduce context size"
  - "audit my context stack"
  - "context is too big"
  - "token hygiene"
tools:
  - shell
  - read
mutating: false
writes_pages: false
upstream: context-audit@fc834ee
---

# context-audit — Token Hygiene for the Always-Loaded Context Stack

> **Convention:** see [conventions/brain-first.md](../conventions/brain-first.md)
> — before running a fresh audit, check the brain for prior audit reports
> (`gbrain recall "context audit report"`) so you can compute token DRIFT since
> the last run and avoid re-flagging findings the user already declined.
>
> **Convention:** see [conventions/quality.md](../conventions/quality.md) —
> every finding cites its file and evidence; no unsourced claims.

## What this is

Every file that loads on every turn is a per-turn tax: tokens, latency, and —
past a point — instruction-following quality. Always-loaded files accrete
(append-only release notes, promoted memory blocks nobody re-reads, rules
restated in three files that drift into contradiction). This skill audits the
whole always-loaded stack at once and returns a ranked, evidence-cited action
list sorted by token savings.

It is an auditor, not a surgeon. It measures, finds, ranks, and recommends.
The user (or a skill the user explicitly invokes afterward) applies changes.

## Scope: what counts as "always-loaded"

Enumerate what THIS harness actually loads every turn — do not assume a fixed
list. Typical stack:

| File | Role | Fix belongs in |
|---|---|---|
| project `CLAUDE.md` / `AGENTS.md` | orientation, routing, invariants | the file itself (source-editable) |
| user-global `CLAUDE.md` | cross-project instructions | the file itself (source-editable) |
| auto-memory `MEMORY.md` | promoted memory blocks | the memory store (demote/expire) |
| `SOUL.md`, `USER.md`, `ACCESS_POLICY.md`, `HEARTBEAT.md`, rendered `AGENTS.md` | bootstrap-rendered identity files | the interview answer bank / templates — NEVER the rendered file |
| harness system-prompt fragments (identity/tools files) | per-harness | wherever that harness sources them |

Skills, reference docs, and anything loaded on demand are OUT of scope as
audit subjects — but they are the DESTINATION for skill-extraction findings
(content that only matters for one workflow should move out of the
always-loaded stack into a skill).

## Contract

This skill guarantees:

- **Report-only.** No audited file is edited, no page is written, nothing is
  auto-fixed — including 🟢 zero-risk findings. The output is a
  recommendation list the user applies deliberately.
- **Rendered-file safety.** Any recommendation touching a bootstrap-rendered
  file is expressed as an answer-bank or template change
  (`gbrain bootstrap interview --set KEY "..."` then
  `gbrain bootstrap render --only <FILE> --force`), never as a direct edit.
  See [skills/soul-audit/SKILL.md](../soul-audit/SKILL.md) for the mechanics.
- **Measured, not guessed.** Token figures come from the deterministic
  pre-pass (`wc -c` / ~4 chars-per-token), never invented.
- **Native judging.** The draft report is quality-gated through
  `gbrain eval cross-modal` — no raw model API calls, no hardcoded model IDs.
- **Cost line.** Default judging is ONE cheap model (the user's utility-tier
  model, all three slots, `--cycles 1` — a few cents). The full
  three-provider frontier panel runs only when the user explicitly asks for
  a "full" or "multi-model" audit (~3x+ the cost per cycle).

## Procedure

### 1. Enumerate the stack (deterministic)

List the always-loaded files for this harness and measure each:

```bash
for f in CLAUDE.md AGENTS.md SOUL.md USER.md ACCESS_POLICY.md HEARTBEAT.md MEMORY.md; do
  [ -f "$f" ] && echo "$f: $(wc -c < "$f") chars (~$(( $(wc -c < "$f") / 4 )) tokens)"
done
```

Record the total. If a prior audit report exists in the brain, compute drift
(net tokens grown/shrunk since last run, which files moved).

### 2. Read and analyze (the agent does this — no model calls yet)

Read every file in the stack in full. Evaluate against six dimensions:

1. **Token efficiency** — tokens spent per unit of behavioral value
2. **Redundancy** — the same rule/fact stated in more than one file
3. **Contradictions** — conflicting rules, numbers, or policies across files
4. **Skill-worthiness** — content that only matters for a specific workflow
   (extraction candidate: move to a skill, load on demand)
5. **Staleness** — outdated facts, references to removed features, promoted
   memory blocks that no longer earn their slot
6. **Clarity** — instructions compressible without behavior change, or
   ambiguous enough to misfire

### 3. Classify every finding by risk

- 🟢 **Zero risk** — pure deletion of exact redundancy or dead content
- 🟡 **Low risk** — compression or skill extraction with a clear trigger
- 🔴 **Medium risk** — changes that could shift edge-case behavior

All three classes are recommendations. The risk class tells the user how much
care to apply — it does not authorize this skill to act.

### 4. Judge the draft through the native eval runner

Write the draft report to a temp file, then gate it:

```bash
# Resolve the cheap judge from the user's model tiers — never hardcode an ID.
# (`gbrain models` shows all resolved tiers if the config key is unset.)
JUDGE=$(gbrain config get models.tier.utility)

gbrain eval cross-modal \
  --task "Context-stack token-hygiene audit: every finding cites file + quoted evidence; savings are measured (chars/4), not guessed; findings ranked by token savings; every rendered-file recommendation targets the interview answer bank or template, never a direct edit; risk class on every row" \
  --output /tmp/context-audit-draft.md \
  --slug context-audit-report \
  --cycles 1 \
  --slot-a-model "$JUDGE" --slot-b-model "$JUDGE" --slot-c-model "$JUDGE"
```

Full multi-model panel (explicit opt-in only — the user asked for a
"full" / "multi-model" audit): omit the `--slot-*-model` overrides so the
runner's native three-provider defaults apply.

Exit codes: `0` PASS — deliver. `1` FAIL — fix the flagged weaknesses in the
draft (usually: an unquoted claim or a rendered-file edit recommendation) and
re-judge. `2` INCONCLUSIVE (provider/key trouble) — deliver the report but
label it "unjudged" prominently.

### 5. Deliver

Print the report in the conversation (see Output Format). If the user wants
it persisted, hand off to the brain-ops skill to file it under `openclaw/`
(agent-state notes) — this skill does not write pages itself.

Re-running after major edits to the stack, or on a schedule, is a
harness-routing convention the user can set up (see the cron-scheduler skill)
— nothing here runs automatically or guarantees a cadence.

## Output Format

```
# Context Audit — YYYY-MM-DD

Stack total: ~NN,NNN tokens across N files (drift since last audit: +/-N,NNN)
Findings: N (~NN,NNN tokens recoverable) | Contradictions: N
Judge verdict: PASS (single-model, utility tier) | receipt: <path>

| # | Save (tok) | Risk | File | Finding | Evidence | Recommended fix (and WHERE it lives) |
|---|-----------|------|------|---------|----------|--------------------------------------|
| 1 | ~2,400    | 🟢   | ...  | redundancy: X restated | "quoted line" | delete from A; canonical copy stays in B |
| 2 | ~1,100    | 🟡   | SOUL.md | stale: ... | "quoted line" | update answer bank key VOICE_REGISTER, re-render — NOT a SOUL.md edit |
...

## Contradictions (fix these first, savings aside)
- FILE-A says "..." but FILE-B says "..." — resolve toward <one>, delete the other.

## Skill-extraction candidates
- <content> only matters when <workflow> — extract via skill-creator, load on demand.
```

Sorted by token savings, descending — except contradictions, which are called
out first regardless of size (they cost correctness, not just tokens). Every
row carries evidence (a quote or line reference) and names WHERE the fix
belongs: source file, answer bank/template, memory store, or a new skill.

## Anti-Patterns

- **Editing any audited file.** Report-only — even 🟢 zero-risk deletions are
  recommendations, not actions. "Auto-fix" promises contradict the
  rendered-file guard and are out of contract.
- **Recommending a direct edit to a rendered file.** SOUL.md / USER.md /
  ACCESS_POLICY.md / HEARTBEAT.md edits are overwritten by the next
  `gbrain bootstrap render`. Target the answer bank or template, then
  re-render.
- **Raw model API calls for judging.** The eval runner owns provider config,
  receipts, and verdict aggregation — route through `gbrain eval cross-modal`.
- **Hardcoding model IDs.** Resolve the judge from the user's model tiers;
  model names in a skill body rot.
- **Running the full multi-model panel by default.** It is an explicit opt-in;
  the single-cheap-model pass is the default for cost reasons.
- **Auditing on-demand content as if always-loaded.** Skills and reference
  docs don't pay the per-turn tax; flagging them inflates savings numbers.
- **Inventing token counts.** Measure with the pre-pass; estimates are labeled
  as `~N` chars/4 approximations.
- **Rewriting identity content yourself.** If a finding is about WHAT an
  identity file says (wrong persona, outdated profile), route to soul-audit —
  the interview is the only author of that content.

## Dedup

- **soul-audit** — identity CONTENT via interview: what SOUL.md/USER.md
  should SAY, sourced from the user's own words. context-audit is
  token/structure hygiene: what the stack COSTS per turn, where it repeats or
  contradicts itself. A finding like "USER.md's profile is outdated" hands
  off to soul-audit; "USER.md restates 800 tokens already in SOUL.md" stays
  here. Both respect the same rendered-file rule.
- **skill-optimizer** — tunes ONE skill's body against a benchmark and can
  mutate it. context-audit never mutates and looks only at always-loaded
  files; skills appear only as extraction destinations.
- **functional-area-resolver** — the compression TECHNIQUE for oversized
  routing tables (>=12KB). context-audit may cite it as the recommended fix
  when a routing section is the finding; it never applies it.
- **skillpack-check** — install/runtime health (DB, worker, migrations), not
  context size or prompt content.
- **cross-modal-review** — general second-opinion gate on arbitrary work
  products. context-audit uses the same underlying runner but as its own
  fixed judging step with audit-specific pass criteria; asking for "a second
  opinion on this code" routes there, not here.
