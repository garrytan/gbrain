# Compression candidates and validation plan

Created 2026-07-24; evidence classification corrected 2026-07-28.

## Status

`yaml-compressed.md` and `hierarchical.md` are candidate resolver variants,
not validated replacements for `functional-areas.md`.

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

## Reproducible model evaluation (not run)

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

No routing-accuracy claim should be promoted until that receipt is reviewed.
Independent blind fixtures and at least one additional provider remain
follow-ups.

## Invalid comparison removed

A draft `gbrain routing-eval --ab-compare` path attempted to score these
prompt variants with the production trigger-table parser. The formats are
different, so all candidates scored `1/66`; that number did not measure LLM
routing quality. The option was removed rather than preserving a misleading
metric. `gbrain routing-eval` remains the deterministic evaluator for its
native routing table and adversarial fixture format.
