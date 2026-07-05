# Task 2 — how to evaluate the patient orchestrator

For another engineer or agent picking this up. Two tiers: **unit tests** (fast, no infra) and a
**live end-to-end smoke** (needs the local model stack). Run tier 1 always; run tier 2 to prove
the real LLM + subagent-job round-trip.

See also: [`task2-patient-orchestrator.md`](./task2-patient-orchestrator.md) (design + status),
[`LOCAL-MODELS-SETUP.md`](./LOCAL-MODELS-SETUP.md) (the local stack), and
`src/core/orchestrator/README.md` (code map).

---

## Tier 1 — unit tests (no DB / model / worker)

Everything is decoupled via injected seams, so the logic runs with plain fakes. Use the dev
container (host has no `bun`). From the repo root:

```bash
docker run --rm -v "$PWD:/app" -w /app oven/bun:1 bash -c "\
  bun install --frozen-lockfile && \
  bun test test/orchestrator.test.ts test/orchestrator-select-llm.test.ts \
           test/orchestrator-routing.test.ts test/orchestrator-loop.test.ts \
           test/orchestrator-execute.test.ts test/orchestrator-backtest.test.ts && \
  bun run typecheck"
```

(Or inside the dev container / `./RUN-DOCKER-CONTAINER.sh`, just run the `bun test …` line.)

**PASS =** `39 pass, 0 fail` and typecheck `0 errors`.

What each file proves:

| Test file | Proves |
|---|---|
| `orchestrator.test.ts` | The **custom-skill gate**: patient data routes only to `nurse/psychiatrist/general-medicine` skills; generic GBrain skills are refused + audited; `assertAllCustom` fail-closed. |
| `orchestrator-select-llm.test.ts` | LLM selector ranks, drops hallucinated/non-candidate skills, tolerates fenced JSON, clamps confidence. |
| `orchestrator-routing.test.ts` | Routing-eval fixtures (`test/fixtures/orchestrator-routing-cases.ts`): each clinical input picks the right top skill; generic input routes nothing. |
| `orchestrator-loop.test.ts` | Feedback loop converges (executes only fresh skills each round); suggest-only with no executor. |
| `orchestrator-execute.test.ts` | Subagent executor maps job result → skill output; failures are recorded, not thrown. |
| `orchestrator-backtest.test.ts` | **Temporal backtest**: key-term extraction + scoring (grades on medical terms, not word-for-word; a missed *critical* term fails), timeline slicing (history≤T vs next-step ground truth), the walk-forward driver end-to-end (oracle passes, lazy predictor fails and surfaces the terms it missed), and the chronicle timeline loader mapping. |

---

## Tier 2 — live end-to-end smoke (real LLM selector + real execution)

This is the **only path unit tests can't cover** (they use fakes). It needs the local stack.

### Prereqs (see LOCAL-MODELS-SETUP.md)
- LM Studio serving a chat model on `:1234` (e.g. `openrouter:qwen/qwen3.6-27b`).
- A brain with some patient data imported + embedded.
- Run gbrain **from source** (`bun src/cli.ts`), not the compiled binary.
- A worker running in a second shell:
  ```bash
  bun src/cli.ts jobs work
  ```

### Run
```bash
CHAT_MODEL="openrouter:qwen/qwen3.6-27b" bash hackathon_planning/orchestrate-smoke.sh
```

It checks three things and prints a `N passed, M failed` summary (exit 0 = all pass):
1. **Skill selection** — the real LLM selector (`gbrain orchestrate`) picks the expected top skill
   for cardiac / mental-health / records inputs.
2. **Guardrail** — a purely generic input routes *no* clinical skill and records `excluded_generic`.
3. **Execution + loop** — `gbrain orchestrate-run` runs a skill as a subagent job and the loop
   terminates (`stopped` is set).

**PASS =** `3+ passed, 0 failed`. (Step 3 needs the worker; if it fails, check the worker shell
and that the model is reachable.)

### Manual spot-checks (optional)
```bash
# Suggest-only (read): ranked clinical skills, never a generic one
bun src/cli.ts orchestrate "reports chest pain and shortness of breath" --json

# Execute (local-only, write): rank + run + feedback loop
bun src/cli.ts orchestrate-run "reports chest pain and shortness of breath" \
  --model openrouter:qwen/qwen3.6-27b --max_rounds 2 --json
```
In the `orchestrate` output, confirm `recommendations[0].skill` is a clinical skill and
`excluded_generic` lists any generic matches (they must never appear in `recommendations`).

### Temporal backtest on real history (`orchestrate-backtest`)

Measures how accurately the system estimates the *next* step given only the data to date. Needs a
patient whose **Life Chronicle timeline is populated** (`timeline_entries` for that source — run
the chronicle extraction first if empty).

```bash
# Suggest-only (read-cheap): rank skills at each cut, score the estimate vs what happened next.
bun src/cli.ts orchestrate-backtest patient-example-id --json

# Higher fidelity: actually run the skills as subagent jobs at each cut (needs `jobs work` + model).
bun src/cli.ts orchestrate-backtest patient-example-id --execute \
  --model openrouter:qwen/qwen3.6-27b --max_cuts 5 --json
```

Read `aggregate` in the JSON: `meanCriticalRecall` is the headline "key medical terms were
accurate" number (1.0 = every critical drug/procedure/red-flag/disposition in each real next step
was named), `passRate` is the fraction of cut points that cleared the bar, and `criticalMissed`
lists terms the system systematically missed. Per-cut `predicted` vs `actual` show each estimate.
Thresholds are tunable (`--recall_threshold`, `--critical_threshold`).

---

## What "correct" looks like (acceptance)

- Patient data is **only ever routed to clinical skills** (role `nurse | psychiatrist |
  general-medicine`). A generic GBrain skill appearing in `recommendations` is a hard failure.
- `orchestrate_input` is **suggest-only** (read-scope). Execution happens **only** via
  `orchestrate_run` (write-scope, local-only) — never remotely, never implicitly.
- The feedback loop terminates (no runaway rounds).

## Not in scope (by design)
- Autonomous clinical action: the orchestrator **suggests and can run decision-support skills**;
  a human reviews outputs. It is not a diagnosis engine (APPI / clinical-safety posture).
