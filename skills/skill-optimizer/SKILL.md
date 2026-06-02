---
name: skill-optimizer
version: 0.1.0
description: Self-evolving skill optimization via SkillOpt-paper-grounded text-space optimizer.
triggers:
  - "optimize this skill"
  - "tune the skill against the benchmark"
  - "make the skill better"
  - "run skillopt"
  - "skillopt for"
mutating: true
brain_first: exempt
---

# Skill Optimizer

Self-evolving skill optimization. Treats SKILL.md as the trainable parameters
of a frozen agent. Validation-gated, budget-capped, atomic-versioned.

Based on SkillOpt (arXiv 2605.23904, Microsoft Research, May 2026).

## When to invoke this skill

The user wants to:
- Improve an existing skill's execution quality against a benchmark
- Bootstrap a benchmark file for a new skill
- Re-tune a skill after switching target models

## Iron Law

- **Validation gating is MANDATORY.** Every candidate must clear median-of-3
  + epsilon=0.05 margin against the sel-set before SKILL.md gets rewritten.
- **Frontmatter mutation is FORBIDDEN.** The optimizer only edits the body.
  Routing surface (`triggers:`, `brain_first:`) stays invariant.
- **Bundled skills require explicit opt-in.** Skills shipping with gbrain
  cannot be auto-mutated; user passes `--allow-mutate-bundled` or
  `--no-mutate` (default for the dream-cycle phase) writes proposed.md
  for review.
- **Bootstrap output requires human review.** Both `--bootstrap-from-skill`
  and `--bootstrap-from-routing` write a sentinel; you must review + STRENGTHEN
  the generated judges, delete the sentinel, and re-run with
  `--bootstrap-reviewed` before optimization can use the file.

## The pipeline

```
gbrain skillopt <skill-name> [flags]
  │
  ├── Pre-flight gates
  │     ├── working tree clean (or --force)
  │     ├── benchmark valid + D_sel >= 5 (D17)
  │     ├── cost preflight (D3) — refuses over --max-cost-usd
  │     └── per-skill DB lock (D14)
  │
  ├── Baseline eval on D_sel (sets best_sel_score)
  │
  ├── for epoch in 1..N:
  │     for step in 1..steps_per_epoch:
  │       ├── forward pass: rollouts on D_train batch
  │       ├── backward pass: reflect × 2 (failures + successes per D7)
  │       ├── rank + clip via LR cosine schedule
  │       ├── apply edits (body-only per D5, tagged result per D9)
  │       ├── validation gate: median-of-3 + epsilon=0.05 (D12)
  │       └── if accept: commit via D8 history-intent-first
  │     │
  │     └── slow update (D6) if no improvement this epoch
  │
  └── Final test eval on D_test → run receipt
```

## Starting a benchmark from the skill itself (the common case)

**The user will NOT hand-write a benchmark, and you shouldn't start from a blank
file either.** When the user says "make skill X better" and
`skills/X/skillopt-benchmark.jsonl` doesn't exist, generate a starter from the
SKILL.md directly:

1. **Generate the starter.** Run:
   ```
   gbrain skillopt X --bootstrap-from-skill
   ```
   One LLM call reads `skills/X/SKILL.md`, infers what the skill produces and what
   "good" looks like, and writes ~15 tasks (each with rule judges) to
   `skills/X/skillopt-benchmark.jsonl` plus a `# BOOTSTRAP_PENDING_REVIEW`
   sentinel. No `routing-eval.jsonl` is needed. Tune the count with
   `--bootstrap-tasks N` (max 50).
2. **Review AND STRENGTHEN the judges.** This is YOUR job and it is load-bearing.
   The generated rule checks are weak drafts — the model tends to emit generic
   `contains`, loose `max_chars`, or invented headings. Read each task, fix soft
   checks, add the must-haves the skill actually requires (real section names,
   real length ceilings, `min_citations` where sources are expected,
   `tool_called`/`tool_not_called` for tools the skill genuinely uses). A thin
   benchmark optimizes for a thin definition of quality — do not rubber-stamp.
3. **Delete the sentinel line** (`# BOOTSTRAP_PENDING_REVIEW`, the last line).
4. **Run the optimizer with `--split 1:1:1`:**
   ```
   gbrain skillopt X --bootstrap-reviewed --split 1:1:1
   ```
   The 1:1:1 split is REQUIRED for a 15-task starter — the default `4:1:5` makes
   the validation set `floor(15/10)=1`, below the `D_sel >= 5` floor, and the
   optimizer refuses with `d_sel_too_small`. (4:1:5 needs ~50 tasks.) Add
   `--dry-run` first to preview cost.

Benchmark line shape (what the generator writes, one per line):
```
{"task_id":"x-001","task":"<user prompt>","judge":{"kind":"rule","checks":[{"op":"max_chars","arg":1800},{"op":"contains","arg":"agenda"}]}}
```

Rule-check vocabulary you'll strengthen with: `contains`, `regex`,
`section_present`, `max_chars`, `min_citations`, `tool_called`, `tool_not_called`.
Rule judges are deterministic and free, but shallow for skills whose quality is
sequencing, privacy, refusal boundaries, or file placement — for those, hand-add
richer checks (or an `llm` judge) during review.

**Fallback — author freehand.** If the generated starter is poor (rare, but
possible for very behavior-shaped skills), discard it and write the JSONL
yourself: read the SKILL.md, write ~15 realistic tasks covering the boring middle,
attach >=2 rule checks each, save to `skills/X/skillopt-benchmark.jsonl`, run with
`--split 1:1:1`. The human walkthrough lives at
`docs/tutorials/improving-skills-with-skillopt.md`.

## Decision tree

| Situation | Action |
|---|---|
| Skill has no benchmark | `gbrain skillopt foo --bootstrap-from-skill` → review + strengthen the judges → delete sentinel → `gbrain skillopt foo --bootstrap-reviewed --split 1:1:1` (see section above) |
| Skill has a `routing-eval.jsonl` and you want a head start | `gbrain skillopt foo --bootstrap-from-routing` → review the generated tasks → `--bootstrap-reviewed` (routing tasks test dispatch; tighten them into quality tasks before trusting) |
| Iterating on an existing skill | `gbrain skillopt foo --benchmark skills/foo/skillopt-benchmark.jsonl` |
| Costly run, want preview | Add `--dry-run` |
| Bundled skill (skills/ in gbrain repo) | Default writes proposed.md; add `--allow-mutate-bundled` to commit |
| Want to review changes before applying | Add `--no-mutate` |
| Mid-run crash | `gbrain skillopt foo --resume <run-id>` |

## Output Format

When invoked, this skill produces:

- Updated `skills/<name>/SKILL.md` (when mutation is allowed)
- `skills/<name>/skillopt/best.md` — pointer copy of current best
- `skills/<name>/skillopt/versions/vNNNN_eN_sN.md` — per-step snapshots
- `skills/<name>/skillopt/history.json` — append-only run record
- `skills/<name>/skillopt/rejected.json` — bounded LRU of rejected edits
- `~/.gbrain/audit/skillopt-YYYY-Www.jsonl` — ISO-week-rotated audit trail

## Anti-Patterns

- **Don't bypass the validation gate.** The median-of-3 + epsilon=0.05 is
  load-bearing; without it, the optimizer accepts noise as improvement.
- **Don't optimize bundled skills without `--allow-mutate-bundled`.** They
  ship with gbrain and are load-bearing for downstream agents.
- **Don't use bootstrap output without strengthening it.** Both
  `--bootstrap-from-skill` and `--bootstrap-from-routing` have the optimizer
  model invent success criteria — generic and weak by default. Review and
  tighten the judges before SkillOpt optimizes against them, or it trains the
  skill toward benchmark artifacts instead of real quality.
- **Don't skip `--split 1:1:1` on a ~15-task starter.** The default `4:1:5`
  split drops the validation set below the `D_sel >= 5` floor and the run
  aborts with `d_sel_too_small`.

## Contract

`runSkillOpt(opts)` returns:
```
{
  outcome: 'accepted' | 'no_improvement' | 'aborted' | 'errored',
  receipt: { run_id, skill_sha8, benchmark_sha8, models, scores, cost },
  finalText: string,
  mutatedSkillFile: boolean,
  proposedPath?: string
}
```

## Related skills

- `skillify` — scaffolds a new skill (use BEFORE skillopt)
- `skillpack-check` — audits skill conformance (item 13 surfaces skillopt status)
- `conventions/quality.md` — output quality standards skillopt enforces via judges
