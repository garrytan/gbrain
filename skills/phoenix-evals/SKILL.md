---
name: phoenix-evals
description: Build and run evaluators for AI/LLM applications using Phoenix.
license: Apache-2.0
compatibility: Requires Phoenix server. Python skills need phoenix and openai packages; TypeScript skills need @arizeai/phoenix-client.
metadata:
  author: email-redacted.example
  version: "1.0.0"
  languages: "Python, TypeScript"
triggers:
  - "phoenix-evals"
  - "phoenix evals"
  - "awesome copilot phoenix evals"
---

# Phoenix Evals

Build evaluators for AI/LLM applications. Code first, LLM for nuance, validate against humans.

## Quick Reference

| Task | Files |
| ---- | ----- |
| Setup | [setup-python](references/setup-python.md), [setup-typescript](references/setup-typescript.md) |
| Decide what to evaluate | [evaluators-overview](references/evaluators-overview.md) |
| Choose a judge model | [fundamentals-model-selection](references/fundamentals-model-selection.md) |
| Use pre-built evaluators | [evaluators-pre-built](references/evaluators-pre-built.md) |
| Build code evaluator | [evaluators-code-python](references/evaluators-code-python.md), [evaluators-code-typescript](references/evaluators-code-typescript.md) |
| Build LLM evaluator | [evaluators-llm-python](references/evaluators-llm-python.md), [evaluators-llm-typescript](references/evaluators-llm-typescript.md), [evaluators-custom-templates](references/evaluators-custom-templates.md) |
| Batch evaluate DataFrame | [evaluate-dataframe-python](references/evaluate-dataframe-python.md) |
| Run experiment | [experiments-running-python](references/experiments-running-python.md), [experiments-running-typescript](references/experiments-running-typescript.md) |
| Create dataset | [experiments-datasets-python](references/experiments-datasets-python.md), [experiments-datasets-typescript](references/experiments-datasets-typescript.md) |
| Generate synthetic data | [experiments-synthetic-python](references/experiments-synthetic-python.md), [experiments-synthetic-typescript](references/experiments-synthetic-typescript.md) |
| Validate evaluator accuracy | [validation](references/validation.md), [validation-evaluators-python](references/validation-evaluators-python.md), [validation-evaluators-typescript](references/validation-evaluators-typescript.md) |
| Sample traces for review | [observe-sampling-python](references/observe-sampling-python.md), [observe-sampling-typescript](references/observe-sampling-typescript.md) |
| Analyze errors | [error-analysis](references/error-analysis.md), [error-analysis-multi-turn](references/error-analysis-multi-turn.md), [axial-coding](references/axial-coding.md) |
| RAG evals | [evaluators-rag](references/evaluators-rag.md) |
| Avoid common mistakes | [common-mistakes-python](references/common-mistakes-python.md), [fundamentals-anti-patterns](references/fundamentals-anti-patterns.md) |
| Production | [production-overview](references/production-overview.md), [production-guardrails](references/production-guardrails.md), [production-continuous](references/production-continuous.md) |

## Workflows

**Starting Fresh:**
[observe-tracing-setup](references/observe-tracing-setup.md) → [error-analysis](references/error-analysis.md) → [axial-coding](references/axial-coding.md) → [evaluators-overview](references/evaluators-overview.md)

**Building Evaluator:**
[fundamentals](references/fundamentals.md) → [common-mistakes-python](references/common-mistakes-python.md) → evaluators-{code|llm}-{python|typescript} → validation-evaluators-{python|typescript}

**RAG Systems:**
[evaluators-rag](references/evaluators-rag.md) → evaluators-code-* (retrieval) → evaluators-llm-* (faithfulness)

**Production:**
[production-overview](references/production-overview.md) → [production-guardrails](references/production-guardrails.md) → [production-continuous](references/production-continuous.md)

## Reference Categories

| Prefix | Description |
| ------ | ----------- |
| `fundamentals-*` | Types, scores, anti-patterns |
| `observe-*` | Tracing, sampling |
| `error-analysis-*` | Finding failures |
| `axial-coding-*` | Categorizing failures |
| `evaluators-*` | Code, LLM, RAG evaluators |
| `experiments-*` | Datasets, running experiments |
| `validation-*` | Validating evaluator accuracy against human labels |
| `production-*` | CI/CD, monitoring |

## Key Principles

| Principle | Action |
| --------- | ------ |
| Error analysis first | Can't automate what you haven't observed |
| Custom > generic | Build from your failures |
| Code first | Deterministic before LLM |
| Validate judges | >80% TPR/TNR |
| Binary > Likert | Pass/fail, not 1-5 |


## Contract

This skill guarantees:

- Implements the upstream GitHub awesome-copilot skill intent for `phoenix-evals`: Build and run evaluators for AI/LLM applications using Phoenix.
- Uses only task-relevant references/scripts/assets from this skill directory.
- Produces source-grounded, concrete output: commands, code changes, configuration, review notes, diagrams, or checklists as the source skill requires.
- Does not invent APIs, tool behavior, repository facts, cloud settings, credentials, or user/project context not present in the repo or supplied by the user.

## Output Format

Lead with the actionable result. For implementation or automation tasks, list changed files/commands and verification output. For advisory/review tasks, return concise findings or steps with relevant paths. Do not dump whole reference files; cite the file path and include only the decisive excerpt.

## Anti-Patterns

- Applying this skill outside its documented domain when a narrower skill exists.
- Fabricating project structure, APIs, credentials, external account state, or cloud resources.
- Copying large references/assets into chat instead of using targeted excerpts.
- Skipping verification after code, config, or workflow changes.
