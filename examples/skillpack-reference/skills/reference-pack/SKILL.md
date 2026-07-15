---
name: reference-pack
description: Reference skill demonstrating the 10/10 skillpack contract. Adds a "what does this skillpack do" answer to the user's agent.
mutating: false
triggers:
  - what is the reference skillpack
  - show me the reference skill
  - explain the skillpack contract
  - what's a 10/10 skillpack
  - how do third-party skillpacks work
---

# reference-pack

This is the canonical reference for a third-party gbrain skillpack. Read
its tree once and you know how to author one.

## What this skill does

When the user asks how third-party gbrain skillpacks work, this skill
points them at the four artifacts every pack ships:

- `skillpack.json` — declares pack metadata + which artifacts the
  doctor scores (skills, unit_tests, e2e_tests, llm_evals, routing_evals,
  runbooks, changelog).
- `skills/<name>/SKILL.md` — frontmatter (name, description, mutating,
  triggers) plus markdown body. Agents route on `triggers:`; the body
  is the in-context instruction set.
- `runbooks/bootstrap.md` — agent-readable post-scaffold steps. gbrain
  DISPLAYS this after `scaffold` lands; the agent walks per-step at
  its own discretion. No auto-executor (codex T1 supply-chain hardening).
- `CHANGELOG.md` — Keep-a-Changelog shape. The doctor's `changelog_
  present_and_current` dimension fails if there's no `## [<version>]`
  entry matching the manifest's `version`.

## What the doctor scores

Ten binary dimensions, split into:

**Core (5; must all pass to publish at any tier):**

1. `manifest_valid` — schema-validates skillpack.json
2. `skills_have_skill_md` — every listed skill has SKILL.md with
   name / description / triggers
3. `routing_evals_present` — each skill has routing-eval.jsonl with
   >= 5 intents
4. `skills_have_unique_triggers` — MECE at the pack level
5. `changelog_present_and_current` — CHANGELOG entry for current version

**Quality badges (5; earn for tier eligibility):**

6. `unit_tests_present` — manifest.unit_tests matches >= 1 file
7. `e2e_tests_present` — manifest.e2e_tests matches >= 1 file
8. `llm_eval_present` — `*.judge.json` with >= 3 cases
9. `bootstrap_runbook_present` — non-empty runbooks/bootstrap.md
10. `license_present` — LICENSE / LICENSE.md / LICENSE.txt non-empty

Tier eligibility:

- `endorsed` — all 10 (gates: Garry's `endorsements.json` overlay
  in the registry)
- `community` — all 5 core + >= 3 of 5 badges (default tier on PR
  merge)
- `experimental` — all 5 core + < 3 badges
- `blocked` — any core fails

Run `gbrain skillpack doctor <pack-dir>` to see exactly which
dimensions a candidate pack passes and the paste-ready fix for each
failure. `--fix --yes` auto-scaffolds the dimensions flagged
`auto_fixable: true` (routing-eval stubs, CHANGELOG entries,
license stub, bootstrap stub, test stubs).

## How agents use this skill

The triggers above route any "what is a skillpack" / "how do third-
party packs work" user phrasing to THIS skill. The agent reads the
markdown body, then either answers the user's question directly or
calls `gbrain skillpack info <name>` / `search <query>` for live
registry data.

## Test + eval coverage

- `test/example.test.ts` — unit test that imports the skill helper
  (stub; replace with real assertions).
- `e2e/example.e2e.test.ts` — integration test gated on DATABASE_URL.
- `evals/reference-pack.judge.json` — LLM-judge eval scoring this
  skill's output against the "does it actually teach the contract"
  bar across happy-path / edge / failure-mode cases.
- `skills/reference-pack/routing-eval.jsonl` — five phrasings users
  ask, all mapped to `expected_skill: reference-pack`.

## Author's checklist

Before pushing, the publisher runs:

```
gbrain skillpack doctor . --quick --json
gbrain skillpack pack
```

The first hits the rubric and prints paste-ready fixes for any failed
dimension. The second emits `reference-pack-<version>.tgz` with a
deterministic SHA-256 the publisher submits to the registry PR.
