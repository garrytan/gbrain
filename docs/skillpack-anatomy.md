# Skillpack Anatomy

Cortex skillpacks are curated runtime capability bundles for hosted company
brains. Public skillpacks must be tenant-safe, Cortex-branded, and suitable for
agents connected through scoped MCP OAuth clients.

## Tree

```text
my-skillpack/
  skillpack.json
  skills/
    <skill-slug>/
      SKILL.md
      routing-eval.jsonl
  runbooks/
    bootstrap.md
  test/
  e2e/
  evals/
  CHANGELOG.md
  LICENSE
  README.md
```

`cortex skillpack init <name>` scaffolds this tree. Replace the stubs with
real tenant-safe content, run `cortex skillpack doctor` between edits, and
`cortex skillpack pack` produces a deterministic package ready for review.

## Agent Use

After `cortex skillpack scaffold <source>` lands the files:

1. The agent walks `skills/*/SKILL.md` frontmatter and reads each pack's
   `triggers:` array on startup or per-message.
2. When user phrasing matches a trigger, the agent reads that `SKILL.md` body
   as in-context instructions.
3. Cortex displays `runbooks/bootstrap.md` once after scaffold but does not
   auto-execute it. Tenant mutation stays explicit.

## Doctor Scoring

Ten binary dimensions are checked by pure functions in
`src/core/skillpack/rubric.ts`. The doctor prints the score, status, and
paste-ready fix for every failure.

<!-- BEGIN auto-generated:rubric -->

### Core dimensions

| # | Name | Description | Auto-fixable |
|---|------|-------------|--------------|
| 1 | `manifest_valid` | skillpack.json passes the v1 schema validator | no |
| 2 | `skills_have_skill_md` | every listed skill has SKILL.md with valid frontmatter (name, description, triggers) | no |
| 3 | `routing_evals_present` | every skill has routing-eval.jsonl with >= 5 intents | yes |
| 4 | `skills_have_unique_triggers` | no two skills in this pack share an exact trigger phrase (MECE) | no |
| 5 | `changelog_present_and_current` | CHANGELOG.md present and contains an entry for the current version | yes |

### Quality badges

| # | Name | Description | Auto-fixable |
|---|------|-------------|--------------|
| 6 | `unit_tests_present` | pack declares unit_tests[] with at least one matching test file | yes |
| 7 | `e2e_tests_present` | pack declares e2e_tests[] with at least one matching test file | yes |
| 8 | `llm_eval_present` | pack declares llm_evals[] with >= 1 file containing >= 3 cases | yes |
| 9 | `bootstrap_runbook_present` | pack declares runbooks.bootstrap and the file is non-empty | yes |
| 10 | `license_present` | LICENSE file exists at the pack root (informational badge) | yes |

_Generated from `src/core/skillpack/rubric.ts` by `bun run scripts/build-skillpack-anatomy.ts`._

<!-- END auto-generated:rubric -->
## Tier Eligibility

| Tier | Requirement |
|------|-------------|
| `endorsed` | All 5 core + all 5 badges, plus Cortex registry approval |
| `community` | All 5 core + at least 3 of 5 badges |
| `experimental` | All 5 core + fewer than 3 badges |
| `blocked` | Any core dimension fails |

## CLI Reference

```bash
cortex skillpack init my-pack
cortex skillpack doctor my-pack
cortex skillpack doctor my-pack --fix --yes
cortex skillpack pack my-pack
cortex skillpack search <query>
cortex skillpack info <name>
cortex skillpack scaffold <source>
cortex skillpack registry --url <registry-url>
```

The hosted Cortex runtime package currently ships only the active SaaS runtime
skills listed in `skills/manifest.json`.
