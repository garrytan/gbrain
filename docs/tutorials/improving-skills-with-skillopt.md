# Auto-improve a skill with `gbrain skillopt`

You have a `SKILL.md`. Sometimes the agent following it does a great job, sometimes
it forgets a step or pads the output. This tutorial takes you from that skill to a
measurably better version of it, in one session, without you hand-editing the
prose. By the end you'll have written your first benchmark, watched the optimizer
propose and test edits, and accepted an improvement that actually scored higher.

Time: ~20 minutes. Cost: ~$1 in API calls for the worked example.

Based on [SkillOpt](https://arxiv.org/abs/2605.23904) (Microsoft Research, May 2026).

## The mental model (two sentences)

Your `SKILL.md` is the trainable parameter; the agent that reads it never changes.
SkillOpt runs the agent against a benchmark of realistic tasks, proposes specific
edits to the skill body, re-tests, and keeps a change **only when it measurably
beats the current version** on a held-out slice.

That's the whole idea. The benchmark is how "better" gets defined — which is why
writing it is the one part you can't skip. Everything else is mechanical.

## The easiest path: generate a starter, then strengthen it

You don't start from a blank file. One command reads the SKILL.md and writes a
full starter benchmark for you:

```bash
gbrain skillopt meeting-prep --bootstrap-from-skill
```

It infers what the skill produces, writes ~15 tasks (each with rule judges) to
`skills/meeting-prep/skillopt-benchmark.jsonl`, and appends a
`# BOOTSTRAP_PENDING_REVIEW` sentinel so nothing runs until a human has looked.
Then you **review and strengthen the judges** (the generated checks are weak
drafts), delete the sentinel line, and run:

```bash
gbrain skillopt meeting-prep --bootstrap-reviewed --split 1:1:1
```

If you run an agent over this brain (OpenClaw, Claude Code, Cursor, any MCP client
with the gbrain skills installed), it does this for you: just say "improve my
meeting-prep skill." It runs `--bootstrap-from-skill`, strengthens the judges,
dry-runs for cost, runs the optimizer, and reports the diff + score delta back.
You keep or discard.

**Read the rest of this tutorial to understand what that command produces** — the
benchmark format, how to strengthen a draft (or write one by hand), how to read
the outcome, and where the output lands.

## What you'll need

- `gbrain` installed and a brain initialized (`gbrain --version` works).
- One embedding/chat provider configured. SkillOpt makes real LLM calls.
  `gbrain models doctor` should show at least one reachable chat model.
- A skill you want to improve, living at `skills/<name>/SKILL.md`. This tutorial
  uses a skill called `meeting-prep` — substitute your own name everywhere.
- A clean git working tree for that skill file (SkillOpt refuses to run over
  uncommitted changes so it can never clobber your edits; `--force` overrides).

If you don't have a skill yet, scaffold one first:

```bash
gbrain skillify scaffold meeting-prep
```

## Step 1: Get a benchmark — generated or hand-written

A benchmark is a `.jsonl` file — **one JSON object per line** — where each line is
a task plus a way to score the agent's answer. It's the crux: the benchmark IS
your definition of "better."

**The recommended way is to generate a starter** (the section above):
`gbrain skillopt meeting-prep --bootstrap-from-skill` writes the file for you, then
you strengthen the judges. The format below is exactly what it produces, so this
section doubles as your guide to reviewing and sharpening a generated draft.

**To follow this tutorial verbatim** (or to hand-curate from scratch), paste this
complete 15-task starter. It's deliberately generic — once you've seen the loop
work, **replace these tasks with your skill's real cases** (that's Step 6):

```bash
cat > skills/meeting-prep/skillopt-benchmark.jsonl <<'EOF'
{"task_id":"mp-001","task":"Prep me for a 1:1 with a direct report I haven't met with in 3 weeks.","judge":{"kind":"rule","checks":[{"op":"max_chars","arg":1800},{"op":"contains","arg":"agenda"},{"op":"contains","arg":"follow-up"}]}}
{"task_id":"mp-002","task":"Prep me for a first sales call with a company I know nothing about.","judge":{"kind":"rule","checks":[{"op":"max_chars","arg":1800},{"op":"contains","arg":"company"},{"op":"min_citations","arg":1}]}}
{"task_id":"mp-003","task":"Prep me for a board meeting where I present the quarterly numbers.","judge":{"kind":"rule","checks":[{"op":"max_chars","arg":1800},{"op":"contains","arg":"metric"}]}}
{"task_id":"mp-004","task":"Prep me for a performance review I'm giving to an underperformer.","judge":{"kind":"rule","checks":[{"op":"max_chars","arg":1800},{"op":"contains","arg":"example"}]}}
{"task_id":"mp-005","task":"Prep me for a candidate interview for a senior backend role.","judge":{"kind":"rule","checks":[{"op":"max_chars","arg":1800},{"op":"contains","arg":"question"}]}}
{"task_id":"mp-006","task":"Prep me for a vendor renewal negotiation where I want a discount.","judge":{"kind":"rule","checks":[{"op":"max_chars","arg":1800},{"op":"contains","arg":"leverage"}]}}
{"task_id":"mp-007","task":"Prep me for a kickoff with a new cross-functional project team.","judge":{"kind":"rule","checks":[{"op":"max_chars","arg":1800},{"op":"contains","arg":"goal"},{"op":"contains","arg":"owner"}]}}
{"task_id":"mp-008","task":"Prep me for a difficult conversation about a missed deadline.","judge":{"kind":"rule","checks":[{"op":"max_chars","arg":1800},{"op":"contains","arg":"impact"}]}}
{"task_id":"mp-009","task":"Prep me for an investor update call after a flat quarter.","judge":{"kind":"rule","checks":[{"op":"max_chars","arg":1800},{"op":"contains","arg":"metric"},{"op":"min_citations","arg":1}]}}
{"task_id":"mp-010","task":"Prep me for a skip-level with someone two reports below me.","judge":{"kind":"rule","checks":[{"op":"max_chars","arg":1800},{"op":"contains","arg":"question"}]}}
{"task_id":"mp-011","task":"Prep me for a customer escalation call after an outage.","judge":{"kind":"rule","checks":[{"op":"max_chars","arg":1800},{"op":"contains","arg":"timeline"}]}}
{"task_id":"mp-012","task":"Prep me for a partnership exploration call with a competitor-adjacent company.","judge":{"kind":"rule","checks":[{"op":"max_chars","arg":1800},{"op":"contains","arg":"company"},{"op":"min_citations","arg":1}]}}
{"task_id":"mp-013","task":"Prep me for a sprint retro where morale has been low.","judge":{"kind":"rule","checks":[{"op":"max_chars","arg":1800},{"op":"contains","arg":"action"}]}}
{"task_id":"mp-014","task":"Prep me for a salary negotiation a report initiated.","judge":{"kind":"rule","checks":[{"op":"max_chars","arg":1800},{"op":"contains","arg":"market"}]}}
{"task_id":"mp-015","task":"Prep me for an all-hands where I announce a reorg.","judge":{"kind":"rule","checks":[{"op":"max_chars","arg":1800},{"op":"contains","arg":"why"}]}}
EOF
```

Each line has three fields:

- `task_id` — a unique label. Anything; you'll see it in the audit trail.
- `task` — the prompt the agent gets, exactly as a user would phrase it.
- `judge` — how the answer is scored. `kind: "rule"` is deterministic and **free**
  (no LLM call): it runs a list of `checks`, and the task's score is the fraction
  that pass.

The rule checks you can use:

| `op` | `arg` | Passes when the agent's answer… |
|---|---|---|
| `contains` | string | includes that substring |
| `regex` | string | matches that regex (multiline) |
| `section_present` | heading text | has a markdown heading with that text |
| `max_chars` | number | is at most that many characters (punishes padding) |
| `min_citations` | number | has at least N citations (markdown links, `wiki/…` refs, `[1]` footnotes) |
| `tool_called` | tool name | the agent called that tool during the rollout |
| `tool_not_called` | tool name | the agent did NOT call that tool |

Rule judges are the right place to start. They're free, deterministic, and they
force you to say concretely what a good answer looks like. (`judge.kind` can also
be `"llm"` with a rubric, or `"qrels"` for retrieval tasks — see the
[reference guide](../guides/skillopt.md) once you outgrow rules.)

### The one gotcha: how many tasks you need

SkillOpt splits your benchmark three ways — **train** (propose edits against),
**sel** (the held-out gate that decides accept/reject), and **test** (final
score). The sel slice must have **at least 5 tasks** or the run refuses, so noise
can't masquerade as improvement.

The default split is `4:1:5`, which means sel is 1/10th of your tasks — so the
default needs **~50 tasks** before it'll run. That's too many for a first
benchmark, which is why every command below passes `--split 1:1:1`: with the
15-task starter that's a clean **5 train / 5 sel / 5 test**, and sel hits the
floor exactly.

```bash
# 15 tasks + --split 1:1:1  →  5 train / 5 sel / 5 test
gbrain skillopt meeting-prep --split 1:1:1
```

If you ever see `D_sel has N task(s) after split (need >=5)`, you either added
fewer than 15 tasks or used a split whose middle number is too small a share.
`--split 1:1:1` on 15+ tasks is the simplest thing that works.

> When you swap in your own tasks (Step 6), keep at least 15 and cover the boring
> middle, not just the edge cases. The benchmark IS your definition of quality;
> a thin benchmark optimizes for a thin definition.

## Step 2: Preview the cost (dry run)

Before spending anything, see what the run will cost:

```bash
gbrain skillopt meeting-prep --split 1:1:1 --dry-run
```

This makes **zero LLM calls** — it just prints the plan and the cost estimate.
A ~15-task benchmark with defaults runs around $0.70–$1.00. The preflight refuses
to start a real run whose estimate exceeds `--max-cost-usd` (default $5.00), so
you can't get surprise-billed mid-run.

> `--dry-run` exits with code **2** ("aborted"). That's the convention for "did
> not run the optimization," not a failure. The cost line is what you came for.

## Step 3: Run it for real

```bash
gbrain skillopt meeting-prep --split 1:1:1
```

You'll watch it work: a baseline eval to set the bar, then per-step forward passes
(run the skill), backward passes (propose edits), and a validation gate that
runs each sel task's judge 3 times and takes the median — accepting only if the
median beats the current best by more than 0.05.

When it finishes, the last lines tell you everything:

```
[skillopt] Outcome: accepted
[skillopt] Best sel-score: 0.840
[skillopt] Final cost: $0.71
[skillopt] SKILL.md rewritten with 6 optimization steps.
```

### Reading the outcome

| Outcome | Exit code | What it means | What to do |
|---|---|---|---|
| `accepted` | 0 | A candidate beat the baseline. SKILL.md was rewritten (or a proposed file written — see Step 5). | Review the diff, keep it. |
| `no_improvement` | 1 | Nothing cleared the gate. Your skill is already good, or the benchmark can't tell good from bad. | Strengthen the benchmark (Step 6) or stop. |
| `aborted` | 2 | A gate stopped it: dirty working tree, over budget, `D_sel < 5`, or `--dry-run`. | Read the message — it names the gate. |

`no_improvement` is not a failure. It's the gate doing its job: it would rather
keep your known-good skill than accept a change it can't prove is better.

## Step 4: See what changed

The optimizer leaves a full audit trail under the skill:

```bash
ls skills/meeting-prep/skillopt/
```

```
best.md                 ← the current winning version (== SKILL.md when accepted)
versions/
  v0001_e1_s1.md        ← every step's candidate, so you can diff any of them
  v0002_e1_s2.md
  ...
history.json            ← append-only record of every accept/reject + scores
rejected.json           ← edits that were tried and didn't help (so it won't retry them)
```

The actual change to your skill is a normal git diff:

```bash
git diff skills/meeting-prep/SKILL.md
```

Run-level events (cost, model, scores per run) also land in the rotating audit
log at `~/.gbrain/audit/skillopt-YYYY-Www.jsonl`.

## Step 5: Accept or reject — and the bundled-skill rule

**For a skill you own** (your own `skills/` dir): an `accepted` run rewrites
`SKILL.md` in place. It's already a git diff — review it, then `git commit` to
keep it or `git checkout` to throw it away. Nothing is committed for you.

**For a skill that ships with gbrain** (anything under the gbrain repo's own
`skills/`): SkillOpt refuses to overwrite it by default and writes the winner to
`skills/<name>/skillopt/best.md` instead, so an optimization pass can never
silently mutate a skill other people depend on. Two ways to handle that:

```bash
# See the proposed improvement without touching SKILL.md (works for ANY skill):
gbrain skillopt meeting-prep --split 1:1:1 --no-mutate
# → writes skills/meeting-prep/skillopt/best.md (the proposed rewrite), prints its path. Copy what you want.

# Actually rewrite a bundled skill (explicit opt-in + an independent held-out set):
gbrain skillopt brain-ops --split 1:1:1 --allow-mutate-bundled \
  --held-out skills/brain-ops/held-out.jsonl
```

Rewriting a bundled skill in place now requires BOTH `--allow-mutate-bundled` AND
`--held-out <path>` (a JSONL with the same shape as your benchmark, but at least 5
tasks whose IDs don't appear in the benchmark). The held-out set is how the run
proves the edit didn't just learn the benchmark: a candidate that climbs the
benchmark but slips on the held-out tasks is refused. Drop `--held-out` and the
run hard-refuses and points you at `proposed.md` instead.

Rule of thumb: `--no-mutate` when you want to read the diff before trusting it
(no held-out needed); `--allow-mutate-bundled --held-out` only when you intend to
commit a proven change to a shared skill.

## Step 6: Iterate

The loop that actually makes skills better:

1. Run it. If `no_improvement`, the benchmark probably can't distinguish good
   from bad yet.
2. Add tasks that capture what you wish the skill did differently. Saw the agent
   skip citations? Add `{"op":"min_citations","arg":2}`. Saw it ramble? Tighten
   `max_chars`.
3. Re-run. A sharper benchmark gives the optimizer a real gradient to climb.
4. When a run lands `accepted`, read the diff, commit it, and bank the win.

The skill you ship gets better every time the benchmark gets sharper. That's the
whole game: you're not editing prose, you're improving the definition of done and
letting the optimizer chase it.

## What you built

You wrote a benchmark that encodes what "good" means for one skill, previewed the
cost, ran the optimizer, and either accepted a measurably better skill or learned
your benchmark needs sharpening. Same loop scales to every skill you own — and
`gbrain skillopt --all` runs it across every skill that has a benchmark, under a
brain-wide cost cap.

## Where to go next

- **Full flag + exit-code reference, cost model, safety guards:**
  [`docs/guides/skillopt.md`](../guides/skillopt.md)
- **Every flag inline:** `gbrain skillopt --help`
- **Batch + fleet + background runs** (`--all`, `--target-models`, `--background`),
  **LLM and qrels judges**, **held-out test sets**, and **resume after a crash**
  (`--resume <run-id>`): all in the reference guide above.
- **Generate a starter benchmark from the SKILL.md** (the recommended way to start):
  `gbrain skillopt <name> --bootstrap-from-skill` → review + strengthen the judges →
  delete the sentinel → `--bootstrap-reviewed --split 1:1:1`. Tune the count with
  `--bootstrap-tasks N` (max 50).
- **Bootstrap from existing routing fixtures** instead: `gbrain skillopt <name>
  --bootstrap-from-routing` (routing tasks test dispatch, not quality — tighten them).
