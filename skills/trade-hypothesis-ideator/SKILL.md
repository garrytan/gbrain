---
name: trade-hypothesis-ideator
description: >
  Generate falsifiable trade strategy hypotheses from market data, trade logs,
  and journal snippets. Use when you have a structured input bundle and want
  ranked hypothesis cards with experiment designs, kill criteria, and optional
  strategy.yaml export compatible with edge-finder-candidate/v1.
---

# Trade Hypothesis Ideator

Generate 1-5 structured hypothesis cards from a normalized input bundle, critique and rank them, then optionally export `pursue` cards into `strategy.yaml` + `metadata.json` artifacts.

## When to Use

- After gathering trade logs, journal entries, or market observations that suggest a potential edge
- When you have a structured input bundle (JSON) with evidence snippets and want falsifiable hypotheses
- To bridge qualitative observations into quantitative experiment designs
- Before committing capital to validate a new strategy idea with kill criteria

## Prerequisites

- Input JSON bundle with one or more of: `trade_log`, `journal_snippets`, `market_data`, `observations`
- Python 3.9+ with `pyyaml` installed
- No external API keys required (pure calculation skill)

## Workflow

1. Receive input JSON bundle.
2. Run pass 1 normalization + evidence extraction.
3. Generate hypotheses with prompts:
   - `prompts/system_prompt.md`
   - `prompts/developer_prompt_template.md` (inject `{{evidence_summary}}`)
4. Critique hypotheses with `prompts/critique_prompt_template.md`.
5. Run pass 2 ranking + output formatting + guardrails.
6. Optionally export `pursue` hypotheses via Step H strategy exporter.

## Scripts

- Pass 1 (evidence summary):

```bash
python3 skills/trade-hypothesis-ideator/scripts/run_hypothesis_ideator.py \
  --input skills/trade-hypothesis-ideator/examples/example_input.json \
  --output-dir reports/
```

- Pass 2 (rank + output + optional export):

```bash
python3 skills/trade-hypothesis-ideator/scripts/run_hypothesis_ideator.py \
  --input skills/trade-hypothesis-ideator/examples/example_input.json \
  --hypotheses reports/raw_hypotheses.json \
  --output-dir reports/ \
  --export-strategies
```

## Output Format

- `hypothesis_cards_<date>.json` — Ranked hypothesis cards with verdicts (`pursue`, `revise`, `discard`)
- `hypothesis_cards_<date>.md` — Human-readable summary with experiment designs and kill criteria
- `strategy_<hypothesis_id>.yaml` — (Optional) Edge-finder-compatible strategy export for `pursue` cards
- `metadata_<hypothesis_id>.json` — (Optional) Provenance metadata for exported strategies

## Resources

- `references/hypothesis_types.md` — Taxonomy of hypothesis patterns (mean-reversion, momentum, event-driven, etc.)
- `references/evidence_quality_guide.md` — Criteria for rating evidence strength and sample size requirements

## Contract
- Inputs: user request / market context
- Outputs: structured analysis guidance

## Anti-Patterns
- Presenting analysis as financial advice or guaranteed profit
