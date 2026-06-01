# MBrain Auto-Promotion Design

Date: 2026-06-01
Status: Design spec (approved in brainstorming, pending implementation plan)
Author: scott.lee + agent

## Goal

Let mbrain promote Memory Inbox candidates to canonical memory **automatically,
without per-candidate human review**, so mbrain works as a low-intervention
second brain. The user should never have to sit down and approve candidates one
by one. The system runs unattended (nightly), uses the user's existing
`claude` / `codex` CLI as the judgment engine, and keeps every automatic write
safe and reversible.

This is a deliberate, bounded re-introduction of "dream writes" — the capability
mbrain dropped when it forked from gbrain — but reshaped to **never bypass the
existing canonical-write governance**.

## Problem

Today the dream cycle and `route_memory_writeback` only *create* candidates;
nothing promotes them automatically. Canonical writes happen only via:

- **Path A** — an agent in a live session calling `put_page` after the router
  returns `canonical_write_allowed`, or
- **Path B** — a candidate manually advanced (`advance_memory_candidate_status`)
  then promoted (`promote_memory_candidate_entry` / `apply_memory_patch_candidate`).

There is no unattended promote driver and no mbrain-native generation runtime.
The restricted-runner framework (`src/core/runners/`,
`src/core/services/restricted-runner-service.ts`) detects runners, plans tasks,
and enforces policy, but its `RestrictedRunnerExecutor` is an unfilled
dependency-injection seam (`restricted-runner-service.ts:319-329`) and
`executeTask` has zero callers. So candidates accumulate and the loop never
self-closes without a human or a live agent session.

## Design Decisions (locked)

- **D1 — Trust model: judge-only, deterministic gate executes.** The CLI runner
  produces a *verdict* only. A deterministic mbrain driver performs the actual
  `advance → promote/apply` through the existing control plane. The runner never
  holds canonical-write tools.
- **D2 — Eligibility for auto-promotion:** `evidence_kind ∈
  {direct_user_statement, source_extracted}` AND no open conflict AND a clear
  page/personal target AND `sensitivity ∈ {public, work, personal}`. Excluded:
  `secret` (never canonical), `unknown` (router blocks canonical write anyway),
  `contradicts_existing`, inferred/ambiguous evidence, `target = other`.
- **D3 — Trigger:** a new `auto_promote` dream-cycle phase that runs under
  autopilot nightly, plus a standalone `mbrain` command sharing the same logic.
- **D4 — Risky candidates: automatic escalation pass.** Candidates that the
  first pass defers (contradictions, ambiguous) get a second pass with a stronger
  CLI model and more context (e.g. attempt contradiction resolution / re-judge).
  Anything still unresolved stays a candidate (non-blocking). Cost controls are
  mandatory: tiered models, escalate-once verdict cache, per-cycle escalation
  cap, and the CLI-subscription cost model (no metered API).
- **D5 — LLM access: direct CLI subprocess invocation, NOT HTTP API.** The
  executor spawns `claude` / `codex` in headless/non-interactive mode, feeds
  scoped + redacted context via the prompt, and parses a JSON verdict from
  stdout. The CLI is invoked in judge-only mode: no MCP write access, no
  canonical-write tools.
- **Operating principle — zero required human intervention.** The morning
  digest is a notification, never a blocking review gate. The system never waits
  on the user.

## Architecture

New `auto_promote` dream phase orchestrates six components. The agent judges;
deterministic code executes.

```
[dream nightly / manual command]
        │
        ▼
1) Candidate Selector (deterministic)
   Query Memory Inbox for eligible candidates (D2 filter)
        ├─ low_risk → first-pass judgment
        ├─ risky    → escalation pass
        └─ excluded → leave as candidate (digest only)
        │
        ▼
2) Runner Executor   ← fills RestrictedRunnerExecutor seam
   Spawn `claude`/`codex` CLI (headless, judge-only)
   In:  scoped + redacted (candidate + relevant canonical context + question)
   Out: JSON verdict {decision, confidence, reasoning, source_refs, proposed_patch?}
   wrapped by 3) Verdict Cache (escalate-once)
        │
        ▼  (risky/defer only)
4) Escalation Pass
   Stronger CLI model + more context; still-defer → stays candidate
        │
        ▼
5) Deterministic Promote Gate   ← existing ops, NOT the CLI
   for verdict.decision==='promote' && confidence>=threshold:
     advance_memory_candidate_status → promote_memory_candidate_entry
                                       / apply_memory_patch_candidate
   (existing preflight, snapshot recheck, mutation ledger, restore window)
        │
        ▼
6) Digest (notification only, non-blocking)
   Record auto_promoted / escalated / deferred / excluded → daily memory report
```

### Invariants

- The CLI produces verdicts only; canonical mutation is performed solely by the
  deterministic gate (5).
- Every auto-write is tagged `actor: mbrain:auto_promote` + verdict id, recorded
  in the mutation ledger, and protected by a restore window — individually and
  batch reversible.
- Runner absent → `deterministic_fallback`: nothing is auto-promoted; candidates
  remain (safe degrade to current behavior).
- Mutating runs hold the existing `dream_cycle:{scope}` cycle lock.
- Gate rechecks `target_snapshot_hash` at write time; if the target changed since
  judgment, that candidate is skipped (no clobber) and stays a candidate.
- Self-consumption guard: auto-promoted pages are canonical, not re-ingested as
  raw; dream-generated content is excluded from candidate input (existing
  `generated_by` filter).

## Components & Interfaces

### 1) Candidate Selector (new deterministic function)
```ts
selectAutoPromoteCandidates(engine, { scope_id, now, policy }): {
  low_risk: MemoryCandidateEntry[];
  risky: MemoryCandidateEntry[];
  excluded: { candidate: MemoryCandidateEntry; reason: string }[];
}
```
Depends on `engine.listMemoryCandidateEntries`, `conflict_sets` lookup.
Eligibility is config-driven (D2 + config toggles).

### 2) Runner Executor (fills existing seam)
Implements the existing type (`restricted-runner-service.ts:84`):
```ts
RestrictedRunnerExecutor = (req: RestrictedRunnerExecutorRequest)
  => Promise<RestrictedRunnerExecutorResult>
```
Implementation = CLI subprocess (judge-only):
- `claude_code`: `claude -p <prompt> --output-format json`, tools/MCP disabled.
- `codex`: `codex exec <prompt>` non-interactive.
- Context injected via prompt (scoped + redacted); stdout → robust JSON parse
  (fence-strip, trailing-junk tolerant; malformed → safe failure, no promotion).
- Per-call timeout; env allowlist; no shell.
- Injected into `createRestrictedRunnerService({ executor })`, which activates the
  currently-unreachable `executeTask`.

### 3) Verdict schema + cache (new)
```ts
PromotionVerdict = {
  candidate_id: string;
  decision: 'promote' | 'reject' | 'defer';
  confidence: number;            // 0..1
  reasoning: string;
  source_refs: string[];
  proposed_patch?: MergePatch;   // when a page body update is needed
  runner_kind: RestrictedRunnerKind;
  model: string | null;
  prompt_version: string;
  judged_at: string;
}
```
Cache table `auto_promote_verdicts`, PK `(candidate_id, content_hash,
runner_kind, prompt_version)` → escalate-once (mirrors gbrain `dream_verdicts`).

### 4) Escalation Pass
New `RunnerTaskType = 'candidate_promotion_review'` with a judge-only tool
allowlist of a single pseudo-tool `emit_promotion_verdict` (no canonical-write
tool — consistent with the existing "propose only" runner-policy model). Risky /
deferred candidates re-invoked with the configured escalation model + expanded
context; bounded by `escalation.max_per_cycle`.

### 5) Deterministic Promote Gate
Pure orchestration over existing ops; no new write path:
```
for verdict where decision === 'promote' && confidence >= threshold:
  advance_memory_candidate_status(captured → candidate → staged_for_review)
  verdict.proposed_patch
    ? apply_memory_patch_candidate(...)
    : promote_memory_candidate_entry(...)
```
Honors `dry_run` (preview, zero mutation) and the cycle lock. Records
candidate → verdict id → mutation event id → restore window.

### 6) Digest (notification only)
Extend `memory-review-report-service` input with auto_promoted / escalated /
deferred / excluded counts and lists. Non-blocking; surfaced in the daily memory
report.

### Config (`~/.mbrain/config.json`)
```jsonc
"auto_promote": {
  "enabled": false,                 // opt-in
  "runner_priority": ["claude_code", "codex", "local_model", "deterministic_fallback"],
  "first_pass_model": null,         // optional cheap CLI model flag
  "escalation_model": null,         // optional stronger CLI model flag
  "confidence_threshold": 0.8,      // min verdict confidence to auto-promote
  "eligibility": {
    "evidence_kinds": ["direct_user_statement", "source_extracted"],
    "sensitivities": ["public", "work", "personal"],
    "allow_contradictions": false
  },
  "escalation": { "enabled": true, "max_per_cycle": 20 },
  "restore_window_hours": 168,      // 7 days
  "dry_run": false
}
```
The `auto_promote` dream phase reads this block; `enabled: false` → skip. The
standalone `mbrain` command shares the logic (contract-first).

## Safety / Failure Modes / Rollback

| Failure | Guard |
|---|---|
| AI false-promote | confidence threshold; 7-day restore window; `actor=mbrain:auto_promote` + verdict id tag → batch revert a bad run |
| Prompt-injection in candidate text | judge-only (no write tools); scoped + redacted context; secret/injection-flagged candidates excluded; gate eligibility + snapshot + restore window backstop |
| CLI unavailable / crash / timeout | `deterministic_fallback` → zero promotions, candidates remain (current behavior); per-call timeout; per-candidate independence |
| Target changed between judge and write | gate rechecks `target_snapshot_hash`; mismatch → skip that candidate, stays candidate |
| Concurrent dream runs | existing `dream_cycle:{scope}` cycle lock |
| Self-consumption loop | auto-promoted pages are canonical, not re-ingested; dream-generated content excluded from candidate input |
| Cost / call runaway | escalate-once verdict cache; `escalation.max_per_cycle`; CLI subscription covers usage |
| Stop / suspected runaway | `enabled:false` master switch; `dry_run` preview; restore window mass-undo |

### Auditability
Every auto-write carries: (1) the verdict (decision + reasoning + confidence +
runner/model), (2) a mutation ledger entry, (3) a page version. "Why was this
promoted?" → read the verdict reasoning. "Undo last night" → filter ledger by
`actor=mbrain:auto_promote` + window, revert.

## Testing

The dangerous part (write) is deterministic, so most safety verification needs
no LLM. The executor is a DI seam — tests inject a fake executor returning canned
verdicts.

- **Unit (no DB, no AI):** selector bucketing per evidence_kind/sensitivity/conflict;
  verdict JSON parsing (fenced/garbled → safe failure); gate threshold + dry_run +
  promote-vs-apply branch; verdict cache escalate-once; config defaults +
  `enabled:false` no-op; fallback → zero promotions.
- **Integration / E2E (PGLite in-memory, stub runner, no API keys, no real CLI):**
  full pipeline (low_risk promoted / risky escalated / excluded untouched / ledger
  + restore window / digest counts); snapshot-changed-mid-flight skip; dry_run zero
  mutation; cycle-lock concurrency block; rollback by actor+window; injection/secret
  candidate excluded.
- **Real CLI (gated, optional, gbrain-Tier-2-style):** spawn real `claude`/`codex`
  with a tiny prompt, assert parseable JSON verdict. Skipped if CLI absent; not in
  fast loop. The only test needing a real CLI.

## Out of Scope

- HTTP-API LLM access (explicitly excluded by D5 — CLI only).
- Full multi-provider chat gateway (mbrain intentionally has none).
- Auto-promoting `secret` candidates (must never become canonical).
- Time-based forced promotion of unresolved candidates.
- UI / dashboard for the review queue.

## Defaults to Confirm During Planning

- `confidence_threshold` default `0.8`.
- `restore_window_hours` default `168` (7 days).
- `escalation.max_per_cycle` default `20`.
- Exact CLI headless flags + JSON-output contract for `claude` and `codex`
  (verify against current CLI versions during implementation).
