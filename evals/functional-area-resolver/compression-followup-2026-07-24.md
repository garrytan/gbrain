# Compression candidates and validation plan

Created 2026-07-24; evidence classification corrected 2026-07-28.

## Status

`yaml-compressed.md` and `hierarchical.md` remain candidate resolver variants,
not production replacements. An isolated-author configured-CLI comparison
supports `yaml-compressed` as the preferred non-inferior candidate; a fully
independent or canonical-harness result is still pending.

The earlier draft reported `20/20` from a deterministic “local
LLM-as-judge”. No JSONL receipt, model identifier, prompt hash, token usage,
or runnable command exists for that result. The claim is withdrawn. A manual
reading of routes is useful design review, but it is not an LLM evaluation and
cannot be described as seeded, deterministic, or equivalent to repeated runs.

## Candidate designs

| Variant | Bytes | Design |
|---|---:|---|
| `variants/yaml-compressed.md` | 5,398 | Removes non-routing prose; retains 14 dispatcher entries |
| `variants/hierarchical.md` | 5,485 | Adds three navigational groups above the same 14 dispatcher entries |
| `variants/functional-areas.md` | 13,503 | Current measured reference |

Both candidates retain `(dispatcher for: ...)` clauses. They also include
`reports`, `cron-scheduler`, and `migrate`, which were absent from the
reference dispatcher lists.

## Evidence available without an API call

`fixtures-compression-validation.jsonl` is a 20-case development corpus:

- 15 positive routing targets;
- 5 explicit abstention cases (`expected_skill: null`);
- all 15 positive targets occur in the dispatcher lists of both candidates;
- the harness parses null expectations and scores only the literal `none` as a
  successful abstention.

These checks prove corpus integrity and structural reachability only. They do
not prove that a model selects the right slug. The corpus is not blind:
candidate dispatcher lists were reviewed and adjusted against it.

The original five-fixture `fixtures-held-out.jsonl` remains unchanged and is
the only historical held-out corpus.

## Configured Hermes CLI evaluation (run 2026-07-28)

The operator requested use of the already-configured CLI. The run therefore
used Hermes with `gpt-5.6-sol` via `openai-codex`, not Anthropic or OpenRouter.
Rules/memory injection was disabled; every call received one resolver and one
intent and was instructed to return only a slug or `none`.

Scope: 2 variants × 20 development fixtures × 3 repeats = 120 calls,
parallelism 9.

| Variant | Strict calls | Positive | Abstention | Per-repeat |
|---|---:|---:|---:|---|
| `functional-areas` reference | 42/60 (70.0%) | 28/45 | 14/15 | 14, 13, 15 / 20 |
| `yaml-compressed` | **57/60 (95.0%)** | 42/45 | **15/15** | 18, 19, 20 / 20 |
| `hierarchical` | **53/60 (88.3%)** | 40/45 | 13/15 | 19, 17, 17 / 20 |

Receipt integrity:

```text
120 run rows
120 unique (variant, fixture_id, repeat) keys
0 non-zero CLI exits
receipt sha256:
4596afe48eefbda8d6d225ef0dd15c6fbbe10679c66048753d581c095a6b1334
```

Receipt:
`/root/audit-artifacts/gbrain-consolidation-20260728/resolver-cli-eval-2026-07-28T16-33-00-226Z.jsonl`.

The reference was evaluated afterward with the same CLI, prompt, fixtures and
three-repeat protocol (60 calls, 60 unique keys, zero CLI errors):

```text
/root/audit-artifacts/gbrain-consolidation-20260728/resolver-cli-eval-2026-07-28T17-50-26-637Z.jsonl
sha256 88752b150d3f6fcf9d4350d67b55f4c094015eda1555053af59029c47194c023
```

Strict deltas against the reference are +25.0pp for YAML and +18.3pp for the
hierarchical candidate. These are development-corpus deltas, not unbiased
compression gains. Nine of the reference's 18 failures are the three targets
`cron-scheduler`, `reports`, and `migrate`, which were added to the candidates
after the development corpus was reviewed.

The ten strict failures were:

- `yaml-compressed`: one `cron-scheduler → recurring-jobs`; two
  `concept-synthesis → query`;
- `hierarchical`: three `cron-scheduler → recurring-jobs`; one
  `concept-synthesis → query`; one `brain-pdf → pdf-ingest`; two failures to
  abstain on “Tell me about my knowledge base” (`gbrain`, `brain-ops`).

Several alternatives are valid members of the same dispatcher area, but they
remain strict failures. The concentration also exposes underspecified fixture
wording where two listed slugs are plausible.

The three passes are independent calls, not provider-controlled seeds: the
Hermes CLI does not expose a seed in this invocation.

## Isolated-author frozen comparison

Before scoring, a separate Hermes session received only baseline catalog
descriptions for skills common to all variants. It did not receive candidate
content or previous results. Its 30-case output was validated without editing
and committed before evaluation:

```text
fixtures-isolated-author-20260728.jsonl
24 positive cases, 24 distinct targets, 6 abstentions
sha256 6c8205a114409ea385da29ffc4652731278000ffa075e942e9f17b9595b39820
freeze commit c6899005
```

Configured-CLI scoring: 3 variants × 30 fixtures × 3 repeats = 270 calls,
zero CLI errors.

| Variant | Strict calls | Positive | Abstention | Per-repeat |
|---|---:|---:|---:|---|
| `functional-areas` | 82/90 (91.1%) | 64/72 | **18/18** | 27, 27, 28 / 30 |
| **`yaml-compressed`** | **83/90 (92.2%)** | **65/72** | **18/18** | 28, 28, 27 / 30 |
| `hierarchical` | 81/90 (90.0%) | 63/72 | **18/18** | 27, 27, 27 / 30 |

Paired disagreements against the reference:

```text
yaml-compressed: reference-wrong/YAML-right=2, reference-right/YAML-wrong=1
hierarchical:    reference-wrong/hierarchy-right=0, reference-right/hierarchy-wrong=1
```

The evidence supports non-inferiority, not a statistically established
accuracy gain. YAML meets the predeclared gate (delta +1.1pp, abstention
equal), is 60% smaller than the reference, and is the preferred candidate.
Hierarchical offers no measured benefit here.

Receipt:

```text
/root/audit-artifacts/gbrain-consolidation-20260728/resolver-cli-eval-2026-07-28T18-07-15-894Z.jsonl
sha256 e724372dd99d1f4d9e30750246c2a6889a6acaef8e221bef34a6bef2409dad26
270 run rows, 270 unique keys, 0 non-zero CLI exits
```

Limit: author and scorer were context-isolated sessions of the same model.
This is stronger than the development corpus, but not perfect blindness.

## Canonical harness evaluation (not run)

After an operator approves the external API cost and provides
`ANTHROPIC_API_KEY`, run from this directory:

```bash
node harness.mjs \
  --model haiku \
  --variants yaml-compressed,hierarchical \
  --held-out-fixtures fixtures-compression-validation.jsonl \
  --parallel 3 \
  --yes
```

This evaluates both the standard 20-case training corpus and the selected
20-case compression corpus, with three seeds: 240 model calls. The harness
prints a provider-aware estimate before calls begin and writes a JSONL receipt
binding the model, prompt, fixture hashes, selected corpus path, harness SHA,
arguments, and per-call results.

This Anthropic run has not been executed. Independent blind fixtures and a
canonical-harness or additional-provider result remain follow-ups before
promoting either candidate to a replacement.

## Invalid comparison removed

A draft `gbrain routing-eval --ab-compare` path attempted to score these
prompt variants with the production trigger-table parser. The formats are
different, so all candidates scored `1/66`; that number did not measure LLM
routing quality. The option was removed rather than preserving a misleading
metric. `gbrain routing-eval` remains the deterministic evaluator for its
native routing table and adversarial fixture format.
