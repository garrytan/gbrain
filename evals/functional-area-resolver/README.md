# functional-area-resolver A/B eval

Maintainer-side eval evidence for the `functional-area-resolver` skill. Lives
outside `skills/` deliberately — the skillpack bundler walks `skills/<skill>/`
recursively, so an eval surface in there would ship to every downstream
`gbrain skillpack install`. This directory is NOT bundled. The pattern (in
SKILL.md) ships everywhere; the eval evidence stays in the gbrain repo where
maintainers can re-baseline.

## What this proves

Three resolver shapes tested across three Anthropic frontier models. The
pattern in `skills/functional-area-resolver/SKILL.md` (functional-area
dispatchers with `(dispatcher for: ...)` clauses) **beats the verbose
bullet-list baseline by +13 to +17pp on training while shipping at 48% the
size**, and **catastrophically beats compression without the dispatcher
clause** on Sonnet (100% vs 41.7% training, lenient).

## Methodology

### Variants

- `variants/baseline.md` — the verbose 270-row bullet-list shape extracted
  from a real production AGENTS.md at git commit `93848ff3b^` (pre-compression
  state), with owner PII scrubbed. ~25KB.
- `variants/functional-areas.md` — the dispatcher pattern at git commit
  `93848ff3b` (the commit titled "AGENTS.md: functional-area resolver —
  25KB→13KB, 100% routing accuracy"). ~13KB.
- `variants/resolver-of-resolvers.md` — derived mechanically from
  functional-areas by stripping `(dispatcher for: ...)` clauses. The ablation
  case: same structure, no sub-skill visibility. ~10KB.

### Corpora

- `fixtures.jsonl` — 20 hand-authored training fixtures used to develop the
  variants. Headline accuracy on training is informative but not the claim
  (same-author overfitting risk).
- `fixtures-held-out.jsonl` — 5 fixtures authored BEFORE the variants and
  not adjusted afterward. Held-out is the canonical claim, but small n means
  it saturates near 100% for most cells.

### Scoring

Every output row carries two scores:

- **STRICT** (`correct`) — predicted slug equals expected exactly.
- **LENIENT** (`correct_lenient`) — predicted is in the same dispatcher area
  as expected per the variant's `(dispatcher for: ...)` clauses. For variants
  without dispatcher clauses (baseline, resolver-of-resolvers), LENIENT
  collapses to STRICT.

Both matter:
- STRICT measures "does the LLM return the exact slug?"
- LENIENT measures "does the LLM land in the right area, even if it picks a
  more-specific sub-skill?" This reflects production agent behavior — landing
  in `gmail` for an email intent succeeds even if the resolver wrote
  `executive-assistant`.

### Repeats + statistics

- n=3 seeded repeats per (fixture, variant, model).
- 95% confidence interval via t-distribution across the 3 seeded means
  (t-critical=4.303 for df=2).
- Models: `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`.

### Receipt format

Each run writes one JSONL with:
- Header row: `{kind:'receipt', model, prompt_template_hash, fixtures_hash,
  fixtures_held_out_hash, harness_sha, ts, cmd_args}` — binds the run to a
  specific harness version and inputs so re-runs are auditable.
- One row per (fixture × variant × seed): full row schema in `harness-runner.ts`.

Baseline receipts committed in `baseline-runs/` after the v0.32.3.0
re-baseline.

## Results (2026-05-11)

Training corpus (n=20, 3 seeds, LENIENT scoring):

| Variant | Opus 4.7 | Sonnet 4.6 | Haiku 4.5 | Size |
|---|---|---|---|---|
| baseline | 81.7% ± 7.2% | 86.7% ± 7.2% | 73.3% ± 7.2% | 25KB |
| **functional-areas** | **98.3% ± 7.2%** | **100% ± 0%** | **88.3% ± 7.2%** | **13KB** |
| resolver-of-resolvers | 63.3% ± 14.3% | 41.7% ± 7.2% | 65.0% ± 12.4% | 10KB |

Held-out corpus (n=5, 3 seeds, LENIENT scoring):

| Variant | Opus 4.7 | Sonnet 4.6 | Haiku 4.5 |
|---|---|---|---|
| baseline | 100% ± 0% | 100% ± 0% | 100% ± 0% |
| **functional-areas** | **100% ± 0%** | **100% ± 0%** | **100% ± 0%** |
| resolver-of-resolvers | 100% ± 0% | **73.3% ± 28.7%** | 100% ± 0% |

Strict numbers and the per-fixture failure traces are in the receipts.

## How to reproduce

From the gbrain repo root with `ANTHROPIC_API_KEY` set:

```bash
cd evals/functional-area-resolver

# Smoke test (1 call, ~$0.01)
node harness.mjs --limit 1 --yes

# Full run on Opus 4.7 (225 calls, ~$1.70)
node harness.mjs --model opus --parallel 3 --yes

# Cross-model
node harness.mjs --model sonnet --parallel 3 --yes      # ~$1.00
node harness.mjs --model haiku --parallel 3 --yes       # ~$0.30

# Re-score an existing run without spending more API budget
node rescore.mjs baseline-runs/2026-05-11-opus-4-7.jsonl

# Unit tests (no API key required)
bun test harness-runner.test.ts
```

The harness routes through gbrain's gateway, so it inherits gbrain's auth,
rate-lease, and cost-meter behavior. Without `ANTHROPIC_API_KEY` it exits with
a clear error.

## Important caveat: the prompt is load-bearing

The harness uses a dispatcher-aware prompt (see
`harness-runner.ts:PROMPT_TEMPLATE`) that explicitly tells the LLM:

> Some entries are functional-area dispatchers shaped like:
>   "**Area name**: triggers... → `dispatcher-skill` (dispatcher for: subskill-a, subskill-b, ...)"
> When the user's intent matches an area, RETURN THE MOST-SPECIFIC SUB-SKILL
> from that area's "dispatcher for" list, not the dispatcher itself.

**Without this instruction, every compression variant collapses to ~30-60%
on training.** A naive "return the skill slug" prompt makes the LLM pick the
area lead instead of drilling into the dispatcher list. This was the failure
mode in run-1 (synthetic variants + naive prompt) before the real-variants +
dispatcher-aware-prompt re-baseline.

If you adopt the pattern in your own agent, the SKILL.md guidance applies
to your harness prompt. Lift the PROMPT_TEMPLATE from this harness or write
your own instruction explaining the dispatcher list.

## Limitations and v0.33.x follow-ups

1. Held-out corpus is small (n=5). Saturated at 100% across most cells. Grow
   to >=20 in v0.33.x.
2. Single vendor (Anthropic). Cross-vendor (Gemini, GPT) is v0.33.x.
3. No description-length sweep yet. Anthropic Agent Skills median is ~80
   tokens of frontmatter; we haven't measured the per-row description length
   sweet spot. v0.33.x.
4. Same-author training corpus + variants. Held-out mitigates partially.
5. No adversarial fixtures (e.g., "I want to do something brain-related"
   without specifying what). v0.33.x.

See `TODOS.md` for the full list.

## Prior art

This eval implements a **static-prompt analog** of hierarchical agent routing,
a 2024-2025 research direction. The published hierarchical schemes resolve
the hierarchy at runtime via a second LLM call; this skill inlines the
hierarchy into a single-LLM-pass dispatcher list.

- AnyTool ([arXiv:2402.04253](https://arxiv.org/abs/2402.04253)) — meta-agent → category → tool hierarchy, +35.4pp over flat retrieval at 16K APIs.
- RAG-MCP ([arXiv:2505.03275](https://arxiv.org/html/2505.03275v1)) — embedding-based pre-retrieval, 49.2% token reduction at 3.2× accuracy gain.
- Anthropic Agent Skills ([engineering blog](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)) — progressive disclosure (~80-token frontmatter loaded at startup; body loaded on match).

## File listing

```
evals/functional-area-resolver/
├── README.md                                       # this file
├── fixtures.jsonl                                  # 20 training fixtures
├── fixtures-held-out.jsonl                         # 5 held-out blind fixtures
├── variants/
│   ├── baseline.md                                 # 25KB, PII-scrubbed from production
│   ├── functional-areas.md                         # 13KB, PII-scrubbed from production
│   └── resolver-of-resolvers.md                    # 10KB, derived ablation
├── harness.mjs                                     # thin Node CLI shim
├── harness-runner.ts                               # TS runner via gbrain gateway
├── harness-runner.test.ts                          # 45 unit tests (no API key)
├── rescore.mjs                                     # zero-cost lenient re-score
└── baseline-runs/
    ├── 2026-05-11-opus-4-7.jsonl                   # 225-row Opus baseline
    ├── 2026-05-11-sonnet-4-6.jsonl                 # 225-row Sonnet baseline
    └── 2026-05-11-haiku-4-5.jsonl                  # 225-row Haiku baseline
```
