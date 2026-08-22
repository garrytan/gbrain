# `gbrain skillopt` — Self-evolving skills

Treat your `SKILL.md` files as the trainable parameters of an agent that
itself never changes. Write a benchmark of realistic tasks; SkillOpt watches
the agent run them, proposes specific edits, re-tests, and only keeps changes
that measurably improve the score.

Based on [SkillOpt](https://arxiv.org/abs/2605.23904) (Microsoft Research,
May 2026).

> **New to this?** Start with the hands-on tutorial:
> [Auto-improve a skill with `gbrain skillopt`](../tutorials/improving-skills-with-skillopt.md).
> It walks you from "I have a skill" to "I accepted a measurably better version"
> in ~20 minutes, including how to write your first benchmark. This page is the
> reference — flags, exit codes, cost model, safety guards.

## The 30-second pitch

```bash
# 1. Generate a starter benchmark from the skill itself (no routing-eval needed)
gbrain skillopt my-skill --bootstrap-from-skill

# 2. Review the benchmark — STRENGTHEN the generated judges (they're weak drafts),
#    then delete the trailing `# BOOTSTRAP_PENDING_REVIEW` line

# 3. Run the optimizer (--split 1:1:1 is required for a ~15-task starter)
gbrain skillopt my-skill --bootstrap-reviewed --split 1:1:1
```

That's the entire workflow. (Already have a `routing-eval.jsonl`? Swap step 1 for
`--bootstrap-from-routing` — but routing tasks test dispatch, not output quality.)

## What's in the box

```
skills/my-skill/
  SKILL.md                          ← what gets optimized (body only; D5)
  skillopt-benchmark.jsonl          ← what success looks like
  skillopt/
    best.md                         ← current best version
    versions/
      v0001_e1_s1.md                ← per-step snapshots
      v0002_e1_s2.md
      ...
    history.json                    ← append-only run record (D8)
    rejected.json                   ← bounded LRU of rejected edits
```

The audit trail lives at `~/.gbrain/audit/skillopt-YYYY-Www.jsonl`
(ISO-week rotated; honors `GBRAIN_AUDIT_DIR`).

## How the loop works

For each step:

1. **Forward pass.** Run the candidate skill against a batch from `D_train`.
2. **Backward pass.** Two reflect calls (failures + successes per D7) propose
   edits to address what worked / didn't work.
3. **Rank + clip.** Top-N edits within the LR budget (cosine schedule by
   default; D10 has the ASCII curve in `orchestrator.ts`).
4. **Apply.** D9 tagged-result patches the body (frontmatter forbidden per
   D5; ambiguous anchors rejected to the rejected-buffer).
5. **Validation gate.** D12 median-of-3 + epsilon=0.05: every sel-task runs
   the judge 3 times, takes the median; only accepts if median > best by
   more than 0.05.
6. **Commit.** D8 history-intent-first 5-step atomic write — crash-safe.

After each epoch with no improvement: D6 slow-update fires. Today it emits
the audit event only; the full meta-edit proposal is a tracked follow-up.

## Flags

| Flag | Default | Purpose |
|---|---|---|
| `--benchmark <path>` | `skills/<name>/skillopt-benchmark.jsonl` | Path to benchmark JSONL |
| `--bootstrap-from-skill` | off | Generate a starter benchmark from SKILL.md (recommended; no routing-eval needed) |
| `--bootstrap-tasks N` | 15 | How many starter tasks `--bootstrap-from-skill` generates (max 50) |
| `--bootstrap-from-routing` | off | Auto-build benchmark from routing-eval.jsonl |
| `--bootstrap-reviewed` | off | Required after human-reviewing bootstrap output |
| `--epochs N` | 4 | Outer-loop iterations |
| `--batch-size N` | 8 | Tasks per inner step |
| `--lr N` | 4 | Max edits per step |
| `--lr-schedule cosine\|linear\|constant` | cosine | Edit-budget decay |
| `--split TRAIN:SEL:TEST` | 4:1:5 | Ratio; refuses if D_sel < 5 |
| `--optimizer-model MODEL` | tier.deep | Reflects + proposes |
| `--target-model MODEL` | tier.subagent | Executes the skill |
| `--judge-model MODEL` | tier.reasoning | Scores rollouts |
| `--patch \| --rewrite` | patch | Edit ops only vs. full rewrites |
| `--dry-run` | off | Cost preview, no LLM calls |
| `--no-mutate` | off | Write proposed.md, don't replace SKILL.md (no held-out needed) |
| `--allow-mutate-bundled` | off | Required to mutate gbrain-bundled skills in place — ALSO requires `--held-out` (>=5 rows) or the run hard-refuses |
| `--held-out <path>` | — | Independent test set (same JSONL shape as the benchmark, task IDs disjoint from it). A candidate that beats the benchmark but regresses on the held-out set is refused. Required for in-place bundled mutation. |
| `--max-cost-usd N` | 5.00 | Hard cap; preflight refuses if exceeded |
| `--max-runtime-min N` | 30 | Wall-clock cap |
| `--force` | off | Bypass dirty-working-tree refusal |
| `--resume <run-id>` | off | Resume a prior interrupted run |
| `--json` | off | Machine-readable stdout |

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Improved + accepted (or `--no-mutate` proposed.md written) |
| 1 | No improvement; best skill unchanged |
| 2 | Aborted by gate (dirty tree, over budget, bench validation, etc.) |

## Cost model

A typical 20-task benchmark with defaults costs ~$0.90 per run:

- 32 rollouts × Sonnet ($0.009 each) ≈ $0.29
- 8 reflect calls × Opus (cached) ≈ $0.25
- 24 sel-judges × Sonnet (cached) ≈ $0.10
- Final test eval ≈ $0.07
- **Total ≈ $0.71**

For a 100-task benchmark: ~$5.00 (right at the default cap). Preflight
refuses to start when the estimate exceeds `--max-cost-usd`.

## Safety guards (the cathedral)

| Guard | Decision | What it prevents |
|---|---|---|
| Validation gate is mandatory | D12 (paper) | Accepting LLM judge noise as improvement |
| Frontmatter mutation forbidden | D5 | Routing surface drift (`check-resolvable` regression) |
| Per-skill DB lock | D14 | Two concurrent runs corrupting history/versions |
| Bundled-skill gate | D16 | Auto-mutating skills shipped with gbrain (in-place mutation requires `--allow-mutate-bundled` + a `--held-out` set of >=5 benchmark-disjoint tasks; else hard-refuse + proposed.md) |
| Held-out gate | F11 | Accepting a candidate that overfits its own benchmark — `--held-out` refuses a candidate whose held-out score regresses below baseline |
| Bootstrap review sentinel | D15 | Self-referential benchmark gaming |
| Read-only tool sandbox in rollouts | D13 | Optimization runs writing junk pages to your brain |
| History-intent-first atomic commit | D8 | Half-written SKILL.md on crash |
| Cost preflight | D3 | Surprise mid-run budget exhaustion |
| Dirty-tree refusal | dry-fix pattern | Overwriting your uncommitted changes |

## Hardening notes (#4119)

Operational truths that keep a run honest. Read these before trusting a
score delta.

### Rule judges are gameable — prefer `llm` rubrics for acceptance

`judge: rule` checks (substring / tool-call assertions) are deterministic and
free, which makes them ideal for smoke coverage — and exactly what a
skill-text optimizer can overfit. The reflect loop sees failing rollouts and
can "improve" the skill by teaching the model to emit the literal strings the
rule checks match, without improving the underlying behavior. Treat rule
judges as cheap regression pins, not acceptance criteria: any benchmark whose
score decides a mutation (`D_sel`, `--held-out`) should lean on `llm` rubric
judges, which grade the trajectory against intent rather than surface tokens.
A planned n-gram overlap gate (reject candidates whose text copies judge
strings verbatim) is a tracked follow-up — until it lands, review accepted
diffs for judge-string echoes before shipping them.

### D13 is a prompt-surface-only limit

Two distinct guarantees get conflated as "the sandbox":

- **D13 (rollout side):** rollouts call a read-only tool allowlist — an
  optimization run cannot write junk pages into your brain.
- **D5 + the apply path (mutation side):** the optimizer edits the SKILL BODY
  MARKDOWN only — the prompt surface. It never touches frontmatter (routing),
  code, config, or hooks.

The corollary cuts both ways. Nothing outside the prompt surface can be
damaged by an accepted candidate — but nothing outside the prompt surface can
be *improved* either. If a benchmark failure is rooted in a missing tool, a
wrong op contract, or retrieval quality, SkillOpt will at best wordsmith
around it; fix the code and re-benchmark instead.

### Sizing `--max-cost-usd`

The preflight estimate is a floor, not a ceiling — reflect retries, judge
re-runs, and the held-out gate add real spend. Rough per-run scaling:

    rollouts ≈ (epochs × steps_per_epoch × batch_size × 1)   # forward passes
             + (accept-gate candidates × |D_sel| × 3)         # median-of-3
             + (|D_test| × 3 × 2)                             # final + baseline
             + (--held-out: |held_out| × 3 × 2 per candidate)

Budget ~$0.01 per Sonnet rollout+judge pair and ~$0.03 per Opus reflect call,
then set `--max-cost-usd` at ~1.5x the estimate so the budget tracker aborts
runaways without killing honest runs at 95%. A tighter built-in estimator is
a tracked follow-up. The wall-clock companion knob is `--max-runtime`: the
deadline is enforced between steps AND inside every gate's rollout loop
(checked before each individual rollout), so a breach aborts within one
rollout rather than one batch.

### Hermetic claude-cli rollouts (`CLAUDE_CONFIG_DIR` recipe)

When the target model routes through the `claude-cli:` recipe, each rollout
child inherits the operator's user-level `~/.claude` state — CLAUDE.md
memory, `settings.json`, hooks. That contaminates measurements: a skill can
score well only because YOUR user-level instructions carried it. For hermetic
runs, set:

    GBRAIN_CLAUDE_CLI_HERMETIC_CONFIG=1 gbrain skillopt run <skill> ...

`1`/`true` points the child's `CLAUDE_CONFIG_DIR` at an isolated empty
per-process directory; any other value is used verbatim as the config-dir
path (pre-seed one if you want a fixed minimal config). **Opt-in on
purpose:** on non-macOS installs the config dir also holds the OAuth session
credentials, so the empty-dir form logs the child out there (macOS keeps
credentials in the keychain and survives). If rollouts start failing auth
after flipping this on, that is why.

## When NOT to use SkillOpt

- **No benchmark.** Optimizing against guesses is worse than not optimizing.
- **Write-flavored skills.** Skills whose job is to `put_page` heavily can't
  use the read-only sandbox; mocked-write capture is a tracked follow-up.
- **Tiny benchmarks (<10 tasks).** D_sel < 5 refuses by default; meaningful
  validation needs ≥20 tasks total per the paper.

## Related skills

- `gbrain skillify scaffold <name>` — create a new skill (use BEFORE skillopt)
- `gbrain skillpack-check <name>` — audit conformance + skillopt status
- `gbrain check-resolvable` — routing MECE validation (NOT mutated by skillopt)
