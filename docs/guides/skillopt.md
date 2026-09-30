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
| `--reflect-max-tokens N` | `skillopt.reflect_max_tokens`, else 32000 (thinking optimizer) / 4096 | Output cap for every optimizer call. See [Optimizer output cap](#optimizer-output-cap) |
| `--models-strict` | `skillopt.models_strict`, else off | Abort before any spend unless every active model was explicitly configured. See [Strict mode](#strict-mode) |
| `--patch \| --rewrite` | patch | Edit ops only vs. full rewrites (both go through the validation gate) |
| `--dry-run` | off | Models banner, strict verdict and cost preview; zero model calls |
| `--no-mutate` | off | Write proposed.md, don't replace SKILL.md (no held-out needed) |
| `--allow-mutate-bundled` | off | Required to mutate gbrain-bundled skills in place — ALSO requires `--held-out` (>=5 rows) or the run hard-refuses |
| `--held-out <path>` | — | Independent test set (same JSONL shape as the benchmark, task IDs disjoint from it). A candidate that beats the benchmark but regresses on the held-out set is refused. Required for in-place bundled mutation. |
| `--max-cost-usd N` | 5.00 | Hard cap; preflight refuses if exceeded |
| `--max-runtime-min N` | 30 | Wall-clock cap |
| `--force` | off | Bypass dirty-working-tree refusal |
| `--resume <run-id>` | off | Resume a prior interrupted run |
| `--json` | off | Machine-readable stdout |

## Exit codes

| Code | Outcome | Meaning |
|---|---|---|
| 0 | `accepted` | Improved + accepted (or `--no-mutate` proposed.md written) |
| 1 | `no_improvement` | The optimizer replied usably at least once; best skill unchanged |
| 2 | `aborted` / `errored` | Aborted by a gate (dirty tree, over budget, bench validation, etc.) or errored, including a run whose optimizer never produced a usable reply (`optimizer_output_unusable`) |

`--dry-run` exits 0, or 1 when strict mode is on and fails.

An `errored` or `aborted` run keeps its checkpoint, and so does a run that
stopped early. The summary prints the run id, the checkpoint path and the
exact resume command. An output-cap failure (a truncated reply, or a one-shot
cap too small for the body) doubles the reflect cap in that command. A
body-too-large or context-window refusal keeps the cap, because the cap
shares the context window. The command also carries the run's mode, cost
cap, runtime cap, `--models-strict`, and `--force` only when the run used
it. A resume accepts a SKILL.md with uncommitted changes when the file is
exactly the text the run itself accepted, so it never needs `--force` for its
own edit; any other change to the file still stops the resume. An early stop
takes its cap remedy from the trailing errors, so a run that stopped on
truncated replies doubles the cap even when it still reports
`no_improvement` or `accepted`. An edits-contract failure puts a quoted
`'<other-model>'` placeholder in place of the optimizer model. The JSON
receipt carries the same `run_id` and `resume_command`. `--resume` refuses
when the benchmark, held-out set or split changed, or when the run would
widen from no-mutate to mutate. You can override the optimizer model, the
reflect cap and the cost cap on resume. The cost cap applies to each run
segment: a resumed run gets a fresh `--max-cost-usd` on top of what earlier
segments spent (the receipt reports that as `prior_segments_cost_usd`), so
after a `budget_exhausted` abort, pass the extra budget you want to allow.
A resume re-runs the trailing steps whose optimizer output was all unusable,
so raising the cap and resuming retries them. Run the resume command in the
same brain context (`--brain`, `GBRAIN_BRAIN_ID` or the mount directory) as
the original run; the command does not carry the brain.

A run that accepted a candidate still reports `accepted` when it later stops
early. `stop_reason` records why the loop ended: `completed`,
`early_stop_unusable_output` or `aborted`.

## Optimizer output

**Say to your agent:** *"Why did skillopt propose no edits?"*

### Optimizer output cap

Every optimizer call has one output cap: both reflect calls in patch mode and
in `--rewrite` mode, plus the eval-internal one-shot rewrite ablation.
`--rewrite` itself works the same as before. Its edits still go through the
validation gate. The CLI does not expose the ungated one-shot path.

Where the cap comes from, highest precedence first:

1. `--reflect-max-tokens N` (MCP op / job param `reflect_max_tokens`, clamped
   to 256-32000 for remote callers).
2. `gbrain config set skillopt.reflect_max_tokens N`. It must be a positive
   integer. An invalid value warns once and falls back to the default. A valid
   value is used exactly, even when it is below the default.
3. The default: 32000 for thinking optimizers (Claude 5 family and other
   thinking-capable models), 4096 otherwise.

The banner shows the effective cap and its source. The receipt records it as
`reflect_max_tokens` and `reflect_max_tokens_source` (`flag`, `config` or
`default`). Every call reserves its full cap against `--max-cost-usd`. If one
call alone would reserve more than the cap, preflight aborts before any spend
and names the role (`reservation_exceeds_cap`).

The LLM judge and the bootstrap generators are **not** governed by this cap.
They keep their own small caps (judge 200 tokens, bootstrap rows 500-8000).
For thinking models those caps are raised to at least 8192, so reasoning
tokens don't use up the whole reply. A judge reply that still hits its cap
records `judge_error: llm_truncated`. A bootstrap row that hits its cap is
skipped, with `truncated` printed on stderr.

### What the optimizer sees

The optimizer gets the whole skill body when it fits the optimizer's context
window. Output cap and prompt overhead are reserved, and the budget assumes
3 chars/token. If the context size is unknown, the limit is 120,000 chars. A
body that does not fit is truncated. The prompt then says `(skill body
truncated: sent X of Y chars)` and the receipt records
`skill_body_truncated: {sent_chars, total_chars}`. The one-shot rewrite
refuses to run on a truncated body.

### Unusable replies fail loud

Each optimizer call records at most one error. When the reply hit the cap, its
partial edits are dropped. When a whole run never gets a usable optimizer
reply, the outcome is `errored` (exit 2), with
`abort_detail: optimizer_output_unusable: <first error>`. After 2 consecutive
steps where every optimizer call failed (any error class), the loop stops and
does not spend the rest of the budget. A deliberate `{"edits": []}` (fenced or
bare) is a usable "nothing to change" reply and is not an error.

Some replies are only partly usable: a few edits are malformed and the rest
are valid. The malformed edits are dropped and counted in
`reflect_invalid_edits_dropped`. That is not an error.

### Error codes

Each code in `reflect_errors` / `abort_detail` produces one receipt
`remediation` entry `{code, fix, docs}`, and `docs` links to the anchor below.
The reflect codes are emitted with a mode, as `reflect_failure_<class>` or
`reflect_success_<class>`. They are listed here once, without the mode.

| Code | Meaning | Cause | Fix |
|---|---|---|---|
| <a id="reflect_truncated"></a>`reflect_truncated` | Reflect reply hit the output cap | Cap too small for the optimizer's reasoning + edits JSON | Raise `--reflect-max-tokens` / `skillopt.reflect_max_tokens` |
| <a id="reflect_empty_reply"></a>`reflect_empty_reply` | Reflect reply was empty or whitespace | Optimizer is not following the edits JSON contract | Try a different `--optimizer-model` |
| <a id="reflect_no_parseable_edits"></a>`reflect_no_parseable_edits` | Reply had no parseable edits array | Optimizer is not following the edits JSON contract | Try a different `--optimizer-model` |
| <a id="reflect_invalid_edits"></a>`reflect_invalid_edits` | Every proposed edit failed validation | Optimizer is not following the edits JSON contract | Try a different `--optimizer-model` |
| <a id="reflect_context_too_small"></a>`reflect_context_too_small` | Call not made: prompt + output cap exceed the context window | Cap or prompt too large for the optimizer's window | Lower the cap, or use an `--optimizer-model` with a larger window |
| <a id="reflect_context_overflow"></a>`reflect_context_overflow` | Provider rejected the prompt as too long | Same as above, detected by the provider | Lower the cap, or use a larger-window `--optimizer-model` |
| <a id="reflect_failed"></a>`reflect_failed` | Reflect provider call failed | Provider/network/auth error | Check `gbrain models doctor`, then resume |
| <a id="one_shot_rewrite_truncated"></a>`one_shot_rewrite_truncated` | One-shot rewrite hit the output cap; nothing promoted | Cap too small for a full rewrite | Raise `--reflect-max-tokens` / `skillopt.reflect_max_tokens` |
| <a id="one_shot_rewrite_output_cap_too_small"></a>`one_shot_rewrite_output_cap_too_small` | One-shot refused before calling: the body cannot fit the cap | `ceil(body chars / 3) + 1024` exceeds the cap | Raise the cap, or use the default reflect mode |
| <a id="one_shot_rewrite_body_truncated"></a>`one_shot_rewrite_body_truncated` | One-shot refused: the body had to be truncated | Skill body larger than the optimizer's context | Lower the reflect cap (it shares the window), use a larger-window `--optimizer-model`, or use reflect mode |
| <a id="one_shot_rewrite_empty_reply"></a>`one_shot_rewrite_empty_reply` | One-shot reply was empty | Optimizer is not following the rewrite contract | Try a different `--optimizer-model` |
| <a id="one_shot_rewrite_failed"></a>`one_shot_rewrite_failed` | One-shot provider call failed | Provider/network/auth error | Check `gbrain models doctor`, then resume |
| <a id="budget_exhausted"></a>`budget_exhausted` | Run aborted at the cost cap | Spend (including each call's full-cap reservation) reached `--max-cost-usd` | Raise `--max-cost-usd` (cycle: `cycle.skillopt.per_skill_cap_usd`), or lower the reflect cap |
| <a id="runtime_exceeded"></a>`runtime_exceeded` | Run aborted at the wall-clock cap | `--max-runtime-min` reached | Raise `--max-runtime-min`, then resume |
| <a id="reservation_exceeds_cap"></a>`reservation_exceeds_cap` | No model call made: one call alone reserves more than the cost cap | Reflect cap x optimizer price exceeds `--max-cost-usd` / `cycle.skillopt.per_skill_cap_usd` | Lower the reflect cap, pick a cheaper model, or raise the cost cap |

In the dream cycle, a skill that hits `reservation_exceeds_cap` is recorded as
`skipped_budget` and makes no calls. It is retried only after
`skillopt.reflect_max_tokens`, `cycle.skillopt.per_skill_cap_usd`,
`pricing.overrides`, the skill's benchmark, the gbrain version or one of the
resolved optimizer, target or judge models changes. An `errored` cycle run does not update
`cycle.skillopt.last_run.<skill>`. It records
`cycle.skillopt.last_error.<skill>` instead, and the skill is retried no
sooner than 24h later.

Example `errored` summary (stderr):

```
[skillopt] Outcome: errored
[skillopt] Failure reason: error
[skillopt] Detail: optimizer_output_unusable: reflect_failure_truncated: 4096 output tokens, max_tokens=4096
[skillopt] Stopped early: optimizer output was unusable for consecutive steps; remaining budget not spent.
[skillopt] Warning: 2 optimizer reply error(s) (optimizer output cap 4096); first: reflect_failure_truncated: 4096 output tokens, max_tokens=4096
[skillopt] Fix (reflect_truncated): The optimizer ran out of output tokens. Raise the cap: --reflect-max-tokens <n> or gbrain config set skillopt.reflect_max_tokens <n>. See docs/guides/skillopt.md#reflect_truncated
[skillopt] Run id: so-20260928-1a2b3c
[skillopt] Checkpoint: skills/meeting-prep/skillopt/checkpoint-so-20260928-1a2b3c.json
[skillopt] Resume: gbrain skillopt meeting-prep --resume so-20260928-1a2b3c --skills-dir skills --benchmark skills/meeting-prep/skillopt-benchmark.jsonl --split 4:1:5 --epochs 4 --batch-size 8 --lr 4 --lr-schedule cosine --optimizer-model openai:gpt-5.2 --target-model anthropic:claude-sonnet-5 --judge-model anthropic:claude-sonnet-5 --reflect-max-tokens 8192 --max-cost-usd 5 --max-runtime-min 30
```

## Model provenance

**Say to your agent:** *"Show me which models my skillopt run actually called"*

### Models banner

Before any spend (and on `--dry-run`), skillopt prints every touchpoint the
run can call. Each row shows the model and the flag, key or env var that chose
it:

```
[skillopt] Models:
[skillopt]   optimizer  anthropic:claude-fable-5-1  (--optimizer-model)
[skillopt]   target     anthropic:claude-sonnet-5  (models.tier.subagent)
[skillopt]   judge      anthropic:claude-sonnet-5  (models.tier.reasoning)
[skillopt]   expansion  anthropic:claude-opus-5  (models.default) *
[skillopt]   chat       anthropic:claude-sonnet-5  (built-in default) *
[skillopt]   embedding  openai:text-embedding-3-large  (~/.gbrain/config.json embedding_model)
[skillopt]   optimizer output cap 32000 tokens (default)
[skillopt]   * not chosen by touchpoint-specific configuration (models.default, a built-in default, a substitution or unknown provenance); --models-strict aborts on these
```

`expansion` is the query-expansion model that the target agent's search tool
calls use. The reranker row appears only when search enables it. Per-task
`judge.model` overrides (benchmark and held-out) are listed with origin
`benchmark`. When no reachable task uses an LLM judge, the judge row reads
`(inactive: rule/qrels benchmark)`. When a configured subagent model can't do
tool calls and is replaced, the row shows `-> substituted: <reason>`. Under
`--all` the banner prints once. After that, a per-skill block appears only
when a skill's plan differs, for example because of task judge overrides.
The receipt stores the plan as `models_plan`, and the `run_start` audit event
carries it too.

### Models called

After the run, the summary prints every model the run actually called. That
includes engine-internal calls, such as query expansion inside rollouts and
embeddings:

```
[skillopt] Models called (full run; a call is one gateway operation, internal retries count once; ~ = estimated cost):
[skillopt]   touchpoint  purpose             model                          calls             tokens in/out  cost
[skillopt]   chat        skillopt.optimizer  anthropic:claude-fable-5-1     8                 182340/41210   $1.9421
[skillopt]   chat        skillopt.target     anthropic:claude-sonnet-5      40                311200/52800   $1.7256
[skillopt]   expansion   engine              anthropic:claude-opus-5        71 (72 attempts)  21300/7100     $0.2840
[skillopt]   embedding   engine              openai:text-embedding-3-large  71                2130/0         ~$0.0003
```

Each row counts gateway operations for one (requested model, served model,
touchpoint, purpose) pair. SDK-internal retries count once. `attempts`
counts every recorded attempt, for example a structured-output fallback
inside one expansion. The purpose is `skillopt.optimizer`, `skillopt.target`
or `skillopt.judge` for the three roles, and `engine` for engine-internal
calls. Failed calls are counted. `~` means the cost was estimated (for
example from char-estimated embedding tokens). `unpriced` means the model has
no price entry. The receipt stores these rows as `models_used`, and the
`run_end` audit event carries them too.

On resume, earlier segments' rows are merged in (`models_used_scope:
'full_run'`) and `prior_segments_cost_usd` records their spend.
`final_cost_usd` covers this segment only. A checkpoint written before this
ledger existed gives `models_used_scope: 'since_resume'`.

### JSON receipt

`--json` prints the receipt on stdout (abridged):

```json
{
  "schema_version": 1,
  "outcome": "errored",
  "receipt": {
    "run_id": "so-20260928-1a2b3c",
    "skill": "meeting-prep",
    "outcome": "errored",
    "abort_reason": "error",
    "abort_detail": "optimizer_output_unusable: reflect_failure_truncated: 4096 output tokens, max_tokens=4096",
    "stop_reason": "early_stop_unusable_output",
    "reflect_errors": ["reflect_failure_truncated: 4096 output tokens, max_tokens=4096"],
    "reflect_invalid_edits_dropped": 0,
    "reflect_max_tokens": 4096,
    "reflect_max_tokens_source": "default",
    "remediation": [
      { "code": "reflect_truncated", "fix": "The optimizer ran out of output tokens. Raise the cap: ...", "docs": "docs/guides/skillopt.md#reflect_truncated" }
    ],
    "resume_command": "gbrain skillopt meeting-prep --resume so-20260928-1a2b3c ... --reflect-max-tokens 8192",
    "models_plan": [
      { "touchpoint": "expansion", "model": "anthropic:claude-opus-5", "source": "models_default", "origin": "models.default", "active": true }
    ],
    "models_strict": { "enabled": false, "ok": false, "violations": [ { "touchpoint": "expansion", "model": "anthropic:claude-opus-5", "source": "models_default", "origin": "models.default", "fix": "gbrain config set models.tier.utility anthropic:claude-opus-5" } ] },
    "models_used": [
      { "requested_model": "anthropic:claude-opus-5", "model": "anthropic:claude-opus-5", "touchpoint": "expansion", "purpose": null, "calls": 29, "attempts": 30, "failed_calls": 0, "input_tokens": 8700, "output_tokens": 2900, "cost_usd": 0.116, "cost_basis": "measured" }
    ],
    "models_used_scope": "full_run"
  }
}
```

The `run_skillopt` MCP op, background job results and the cycle phase carry
the same `remediation`, `abort_reason`, `abort_detail` and `run_id`.

### Strict mode

**Say to your agent:** *"Run skillopt only with models I've explicitly configured"*

```bash
gbrain skillopt my-skill --models-strict --dry-run   # preview the verdict, zero calls
gbrain config set skillopt.models_strict true        # enforce for every run
```

Strict mode guarantees that **every active model was chosen by explicit,
touchpoint-specific configuration**. It does not pin a model identity, and
aliases are allowed. Explicit means: a CLI flag, a role or tier key
(`models.tier.*`, `models.chat`, ...), an env var, the servable `config.json`
pin, a benchmark task's `judge.model`, or an embedding/reranker key.
`models.default` does **not** count. It is a catch-all that silently decides
touchpoints you never looked at, such as query expansion. Built-in defaults,
capability substitutions and unknown provenance (for example a legacy
background job) don't count either.

The check covers every touchpoint the run *could* call: optimizer, target,
the judge (when some reachable task uses an LLM judge without its own
`judge.model`), expansion, chat, embedding, and the reranker when it is
enabled. It checks these before any spend, even ones a given run may never
end up calling. It applies to the CLI, the MCP op, the cycle phase, background
jobs (re-checked when the job runs), `--all`, `--target-models` fleets and
both bootstrap modes. A violation aborts with each offending touchpoint and a
copy-paste fix:

```
models strict check: 1 active model touchpoint(s) were not chosen by touchpoint-specific configuration:
  expansion  anthropic:claude-opus-5  (models.default)
    gbrain config set models.tier.utility anthropic:claude-opus-5
```

For an embedding violation, the fix points to `embedding_model` in
`~/.gbrain/config.json` or `GBRAIN_EMBEDDING_MODEL`, since changing it needs
an embedding migration. `skillopt.models_strict` accepts
`true|1|yes|on` and `false|0|no|off|empty`. Any other value warns once and
counts as **on**, and so does a setting that cannot be read.

What strict mode does not cover: the check runs on the plan before spend. A
rollout that asks a search tool for a specific, non-default embedding column
is not re-checked at call time.

### Newer models (`gbrain models`)

`gbrain models` adds an advisory `[newer <family> available: <id>]` hint, with
the `gbrain config set` command, when a configured Anthropic haiku/sonnet/opus
model is older than the newest priced model of the same family in the recipe.
Dated and undated ids of the same version compare equal. The hint is
informational only. Built-in defaults are unchanged, and a validated
default-model migration is tracked separately.

## Cost model

A typical 20-task benchmark with defaults costs ~$0.90 per run:

- 32 rollouts × Sonnet ($0.009 each) ≈ $0.29
- 8 reflect calls × Opus (cached) ≈ $0.25
- 24 sel-judges × Sonnet (cached) ≈ $0.10
- Final test eval ≈ $0.07
- **Total ≈ $0.71**

For a 100-task benchmark: ~$5.00 (right at the default cap). Preflight
refuses to start when the estimate exceeds `--max-cost-usd`.

## Safety guards

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

## Hardening notes

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
purpose:** the config dir also holds the CLI's session credentials, so the
empty-dir form logs the child out wherever the CLI reads its session from the
config dir — macOS included (observed with Claude Code 2.1.x). If rollouts
start failing auth (`Not logged in · Please run /login`) after flipping this
on, that is why: the run now ends `errored` with that message as the failure
detail instead of finishing as a `no_improvement` with a 0.000 score. For a
hermetic run that stays authenticated, use the explicit-path form and
pre-seed that directory with a logged-in config.

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
