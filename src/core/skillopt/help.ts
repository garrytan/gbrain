/**
 * gbrain skillopt --help text.
 */

export const SKILLOPT_HELP_TEXT = `gbrain skillopt <skill-name> [flags]

Self-evolving skill optimization. Treats SKILL.md as the trainable parameters
of a frozen agent. Validation-gated, budget-capped, atomic-versioned.

Based on SkillOpt (arXiv 2605.23904, MSR May 2026).

Required (one of):
  --benchmark <path>            JSONL benchmark file
  --bootstrap-from-skill        Auto-build a starter benchmark from SKILL.md
                                itself (no routing-eval needed). Emits ~15 tasks
                                + rule judges, writes the review sentinel. The
                                recommended way to start a brand-new benchmark.
  --bootstrap-tasks N           How many starter tasks --bootstrap-from-skill
                                generates. Default 15, max 50.
  --bootstrap-from-routing      Auto-build benchmark from routing-eval.jsonl
                                (writes sentinel; requires --bootstrap-reviewed
                                after human review)
  --bootstrap-reviewed          Confirm bootstrap benchmark was hand-reviewed

Training knobs:
  --epochs N                    Default 4
  --batch-size N                Default 8
  --lr N                        Max edits per step. Default 4
  --lr-schedule cosine|linear|constant
                                Default cosine
  --split TRAIN:SEL:TEST        Default "4:1:5"; refuses if D_sel < 5

Models:
  --optimizer-model MODEL       Reflects + proposes. Default models.tier.deep
  --target-model MODEL          Executes the skill. Default models.tier.subagent
  --judge-model MODEL           Scores rollouts. Default models.tier.reasoning

Modes:
  --patch                       Edit ops only (default; safer)
  --rewrite                     Allow full rewrites of sections
  --dry-run                     Plan + cost estimate, no LLM calls
  --no-mutate                   Write proposed.md without replacing SKILL.md
  --allow-mutate-bundled        Required to mutate a bundled skill in place.
                                ALSO requires --held-out (>=5 rows); without it
                                the run hard-refuses (exit 2). Drop this flag to
                                get proposed.md for review instead.
  --json                        Machine-readable stdout

Safety:
  --max-cost-usd N              Hard cap. Default 5.00. Preflight refuses
                                if estimate exceeds.
  --max-runtime-min N           Wall-clock cap. Default 30
  --force                       Bypass dirty-working-tree refusal (rare)
  --resume <run-id>             Resume a prior interrupted run

Batch + fleet + background:
  --all                         Optimize every skill with a benchmark
                                (per-skill cap = --max-cost-usd; brain-wide
                                cap = --brain-wide-max-cost-usd, default $10)
  --brain-wide-max-cost-usd N   Cumulative ceiling for --all (default 10.00)
  --target-models a,b,c         Fleet mode: optimize ONCE per model. Always
                                runs no-mutate; per-model receipts under
                                skills/<name>/skillopt/fleet/<slug>/
  --background                  Submit as a Minion job + print job_id; exits.
                                Combine with --follow to attach.
  --held-out <path>             Independent held-out test set (JSONL, same shape
                                as the benchmark). The held-out gate refuses to
                                promote a candidate whose held-out score is below
                                baseline (benchmark-gaming defense). REQUIRED
                                (>=5 rows) to mutate a bundled skill in place.

Exit codes:
  0 = improved + accepted (or --no-mutate proposed.md written)
  1 = no improvement (best skill unchanged)
  2 = aborted by gate (dirty tree / over budget / bench validation / etc.)

Examples:
  # Generate a starter benchmark from the skill itself (recommended):
  gbrain skillopt meeting-prep --bootstrap-from-skill
  # ...then review + strengthen the judges, delete the sentinel line, and run:
  gbrain skillopt meeting-prep --bootstrap-reviewed --split 1:1:1

  # Bootstrap benchmark from existing routing-eval, then review:
  gbrain skillopt meeting-prep --bootstrap-from-routing

  # After review (sentinel deleted), run the optimizer:
  gbrain skillopt meeting-prep --bootstrap-reviewed

  # Dry-run cost preview:
  gbrain skillopt meeting-prep --dry-run

  # Optimize a bundled skill in place (requires an independent held-out set):
  gbrain skillopt brain-ops --allow-mutate-bundled --held-out skills/brain-ops/held-out.jsonl
  # ...or omit --allow-mutate-bundled to get proposed.md for manual review (no held-out needed).

  # Resume after interruption:
  gbrain skillopt meeting-prep --resume <run-id>

See: docs/guides/skillopt.md
`;
