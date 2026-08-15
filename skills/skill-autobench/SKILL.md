---
name: skill-autobench
version: 1.0.0
description: |
  Author an eval for an existing skill from its REAL usage history, not its
  spec. Mine invocations from the brain's conversation archive
  (conversations/) and per-harness session transcripts — a user correction
  after an invocation is the gold signal — then synthesize an eval_contract
  plus 4-8 replayable cases with honesty labels (SPEC-DERIVED vs
  HISTORY-IMPLIED) and stage the result at skills/<name>/eval/autobench-<date>.md
  as PENDING-HUMAN-APPROVAL. Never rewrites SKILL.md. Ships two guard
  companions: panel integrity (multi-model judging must prove each provider
  actually responded) and the fail-improve taxonomy (logged LLM-fallback
  cases convert to deterministic code over time).
triggers:
  - "skill autobench"
  - "autobench"
  - "write the eval from usage history"
  - "synthesize an eval for this skill"
  - "mine how this skill is actually used"
  - "build a benchmark from my corrections"
  - "verify the eval panel"
  - "did all providers return"
requires:
  - dir:conversations/
mutating: true
writes_pages: false
writes_to:
  - skills/<name>/eval/
upstream: skill-autobench@fc834ee + panel-integrity@fc834ee + fail-improve-loop@fc834ee (taxonomy only)
---

# skill-autobench — write the eval from lived usage

> **Convention:** see [conventions/brain-first.md](../conventions/brain-first.md) —
> mining starts in the brain. Search the conversation archive before touching
> raw transcript files, and never declare "no history" without having queried
> the brain first.
>
> **Convention:** see [conventions/model-routing.md](../conventions/model-routing.md) —
> mining and synthesis run on the cheap tier by default. The full multi-model
> judging pass is an explicit opt-in (see Contract).

The self-improving loop has three legs: an **eval**, a **variant generator**
(SkillOpt), and a **replay + judge harness** (`gbrain eval cross-modal`). The
generator and the judge ship with gbrain. The persistently missing leg is the
**eval author** — someone has to WRITE the eval, and a spec-derived benchmark
only tests what the skill promised, not what users actually asked for or what
actually went wrong. This skill writes the eval from reality instead of
imagination.

## Pipeline

### 1. MINE — extract real invocation windows

Substrates, in priority order:

1. **Brain conversation archive** — pages under `conversations/`, populated by
   the conversation-archive skill (hard dependency for this substrate: if it
   hasn't ingested your history yet, run it first). Search for the target
   skill's name, trigger phrases, and output shapes:

   ```bash
   gbrain search "<skill-name>"
   gbrain query "when did I use <skill-name> and what did I ask for"
   ```

2. **Per-harness session transcripts, as available** — use what the harness
   exposes; do not assume a layout. `gbrain transcripts recent --full` reads
   the configured local transcript corpus (local-only by design). Claude Code
   keeps per-project session JSONL under `~/.claude/projects/`; other
   harnesses have their own session stores. Absent stores are simply skipped.

From each hit, extract an **invocation window**: the user ask before the
invocation, the invocation turn itself, and the 2 turns after — because that
is where corrections live. **A user correction after an invocation is the
gold signal**: it is a real, observed failure mode, and it becomes a
`hard_fail` plus a replayable case.

**FAIL-CLOSED:** if no substrate yields a single real invocation of the
target skill, emit an honest no-history report (substrates checked, queries
run, windows scanned, zero matches) and stop. Do NOT invent "typical"
invocations. For a skill with no history, the right tool is
`gbrain skillopt <name> --bootstrap-from-skill` (spec-derived, and honest
about it) — see Dedup.

### 2. SYNTH — turn windows into a proposed eval

From the mined windows plus the current SKILL.md, produce:

- A proposed **eval_contract**: goal, dimensions, hard_fails. Dimensions come
  from observed asks; hard_fails encode observed corrections.
- **4-8 replayable cases**, each shaped
  `{input, expected_behavior, failure_mode_to_catch}` — realistic input, a
  checkable expected behavior, and the named failure mode the case exists to
  catch.
- **Spec-vs-usage gaps**: "the spec says X, users consistently ask Y."

**HONESTY LABELS are mandatory.** Every dimension and every case is labeled:

- `HISTORY-IMPLIED` — a real mined window backs it; cite which one.
- `SPEC-DERIVED` — inferred from SKILL.md only; no usage evidence.

Never conflate the two. If history is thin or off-target, say so prominently
at the top of the staged file ("GROUNDING WARNING: only N windows found, none
exercised the core path") instead of padding with fabricated evidence.

**Privacy scrub before staging:** staged evals live in the skill repo and are
distributable. Mined windows contain real names, companies, and deals —
rewrite every case onto placeholder slugs (`alice-example`, `acme-example`)
before writing the file. A history-grounded case keeps its shape and failure
mode, never its real entities.

### 3. STAGE — human gate, always

Write `skills/<name>/eval/autobench-<date>.md` with frontmatter
`status: PENDING-HUMAN-APPROVAL`.

**This skill NEVER rewrites SKILL.md** — not the eval_contract, not the body,
not the triggers. Merging the staged eval is the human's decision. (This is a
workflow contract the agent must honor, not a mechanically-enforced gate.)

## The loop (after approval)

1. Human reviews, edits, and approves the staged eval; the approved
   eval_contract is merged into the skill's frontmatter explicitly.
2. Convert approved cases into `skills/<name>/skillopt-benchmark.jsonl` lines
   and run `gbrain skillopt <name>` — this is the SkillOpt surface extension:
   a history-grounded benchmark replacing the spec-derived bootstrap.
3. Judge outputs through the native gate:

   ```bash
   gbrain eval cross-modal --task "<what the output was meant to achieve>" --output <path>
   ```

4. Re-run autobench after more usage accumulates; diff against the prior
   staged baseline.

## Panel integrity — trust no aggregate

Multi-model judging is only as good as the panel being real. The silent
failure class: a model-id normalizer strips provider prefixes and every
"different model" call lands on one host, so a "3-frontier consensus" is one
model's opinion in a trench coat. Before trusting any multi-model verdict,
assert over the result object:

1. **Each named model returned a non-empty response.** An empty or failed
   slot is the first tell of a collapse.
2. **Responses came from DISTINCT provider endpoints.** If three "different
   models" all report the same provider, the panel collapsed to one host.
3. **No two "different models" returned byte-identical output.** If two
   differently-named models return the same bytes, they are the same model.
   This catches a collapse even when provider metadata is missing or faked.

`gbrain eval cross-modal` already exits 2 (INCONCLUSIVE) when fewer than 2/3
models return parseable scores; the byte-identical duplicate check and the
distinct-endpoint check are the independent backstops this skill layers on
top. Run them over the receipt JSON (written to the receipt dir) before
treating a PASS/FAIL as authoritative. The integrity check is pure assertion
logic over an existing result — it never calls a model itself: no network,
no cost.

## Fail-improve taxonomy — what mined failures become

Classify each mined correction/failure case by its cheapest durable fix:

| Class | Signal in history | Durable fix |
|---|---|---|
| DETERMINISTIC-CODIFIABLE | An LLM fallback repeatedly handles the same input shape (regex, parsing, slugs, dates) | Convert to deterministic code + a permanent test case. The LLM is not the solution; it is the training-data generator for the code that replaces it. |
| PROMPT-FIXABLE | The correction targets tone, format, or an omission the SKILL.md could specify | An eval case + a `gbrain skillopt` run |
| SPEC-GAP | Users consistently ask for something the spec never promised | A spec-vs-usage gap observation for the human |
| ROUTING-MISS | The skill fired on the wrong ask, or failed to fire | A `routing-eval.jsonl` case, not a benchmark case |

Direction of travel: every fixed failure becomes a permanent test, the
deterministic share rises, and the LLM-fallback share falls. Log and improve;
never silently drop a mined failure.

## Contract

- **Input:** a skill name that exists under `skills/`.
- **Substrates:** `conversations/` archive pages (brain-first), then
  per-harness session transcripts as available (`gbrain transcripts recent`
  is local-only by design). No usable substrate → honest no-history report,
  never fabricated evidence.
- **Output:** one staged file at `skills/<name>/eval/autobench-<date>.md`,
  `status: PENDING-HUMAN-APPROVAL` — or the no-history report. Never an edit
  to SKILL.md, triggers, or any routing surface.
- **Cost posture:** cheap-model default for mining and synthesis. The full
  multi-model judging pass (3 provider slots per cycle) is an explicit
  opt-in, and judging goes through native `gbrain eval cross-modal` — no
  bespoke judging harness.
- **Honesty:** every dimension and case carries a SPEC-DERIVED or
  HISTORY-IMPLIED label; thin history is flagged, not papered over.
- **Privacy:** mined cases are rewritten onto placeholder entities before
  staging.

## Output Format

```markdown
---
skill: <name>
status: PENDING-HUMAN-APPROVAL
generated: <date>
substrate: { conversation_pages: N, transcript_files: M, windows: K, corrections: C }
---

# Autobench: <name> — <date>

## Grounding
<one paragraph: how much real history backs this eval; GROUNDING WARNING if thin>

## Proposed eval_contract
goal / dimensions (each labeled HISTORY-IMPLIED|SPEC-DERIVED) / hard_fails

## Cases (4-8)
### case-01 [HISTORY-IMPLIED — window ref]
input: ...
expected_behavior: ...
failure_mode_to_catch: ...

## Spec-vs-usage gaps
- spec says X; users ask Y (windows: ...)

## Fail-improve classification
- case-03 → DETERMINISTIC-CODIFIABLE (same date-format fallback, 4 windows)
```

## Anti-Patterns

- ❌ Auto-merging a synthesized eval into SKILL.md. The human gate is the
  contract.
- ❌ Presenting SPEC-DERIVED dimensions as history-grounded — fabricating
  usage evidence is the cardinal sin.
- ❌ Mining nothing and still emitting a confident eval. Fail loudly or label
  honestly.
- ❌ Trusting "3 models scored it 8/10" without checking that three providers
  actually returned distinct, non-identical responses.
- ❌ Calling a model inside the panel-integrity check — it is pure assertion
  logic over a result object.
- ❌ Building a bespoke judging harness when `gbrain eval cross-modal` is the
  native gate.
- ❌ Staging mined cases with real people/companies in them. Placeholders
  only.

## Dedup (sharp boundaries)

- **skill-optimizer (SkillOpt, host-side)** — optimizes a skill's body
  against an EXISTING benchmark; its `--bootstrap-from-skill` derives tasks
  from the spec. THIS skill authors the benchmark from lived usage and feeds
  it into `skills/<name>/skillopt-benchmark.jsonl` — it extends SkillOpt's
  surface, never duplicates it. Read the skill-optimizer SKILL.md (on the
  host, where its engine lives) before the handoff. No history at all → use
  `--bootstrap-from-skill`, not this.
- **BrainBench (`gbrain eval` suites)** — evals the ENGINE (retrieval,
  memory conformance, calibration). This evals SKILLS over their history.
- **`skills/skillify/SKILL.md` / `skills/skill-creator/SKILL.md`** — create
  skills from descriptions; they don't mine lived usage.
- **`skills/cross-modal-review/SKILL.md` / `gbrain eval cross-modal`** — RUN
  judging panels; they don't author evals. The panel-integrity assertions
  here verify their panels were real.
- **`skills/skillpack-check/SKILL.md`** — audits skill structure/conformance,
  not behavior quality.
- **`routing-eval.jsonl`** — tests dispatch (does the right skill fire);
  autobench tests behavior after dispatch. ROUTING-MISS findings route there.
