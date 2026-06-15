# Brittle Counts and Generated Maps

Status: issue #13 implementation note

This pass removes broad hard-coded counts from current operational docs and
keeps numbers only where they are scoped to a source or a worked example.

## Replaced Claims

| Surface | Previous claim | Replacement |
| --- | --- | --- |
| `README.md` | `30+ tools over MCP` | Count-free "operation surface over MCP" wording. |
| `README.md` | `~47 operations both engines implement` | Count-free "shared operation surface both engines implement" wording. |
| `CLAUDE.md` | `GBrain ships 29 skills` plus an exhaustive-looking family list | Resolver-first wording. `skills/RESOLVER.md` is the source of truth for the current bundled skill surface. |
| `docs/TESTING.md` | `3650+ tests` in the local fast-loop row | Count-free wording that tells readers to use runner output for the current count. |
| `scripts/llms-config.ts` project summary | `26 fat-markdown skills` | Count-free "resolver-routed skill surface" wording. |
| `scripts/llms-config.ts` scaling guide description | Broad `300+ skills` framing plus `306 skills` in generated map text | Scoped as a 306-skill production case study rather than a current repo-wide count. |

## Generated Map Authority

`llms.txt` and `llms-full.txt` are generated outputs, not hand-maintained
documentation pages. The source of truth for their structure and descriptions is
`scripts/llms-config.ts`; the generator is `scripts/build-llms.ts`.

Current guidance now appears in:

- `README.md`: LLM entrypoint callout tells editors to update source docs or
  `scripts/llms-config.ts`, then run `bun run build:llms`.
- `AGENTS.md`: agent protocol says the maps are generated and should not be
  hand-edited without updating the generator source.
- `INSTALL_FOR_AGENTS.md`: machine-readable context section tells forks to set
  `LLMS_REPO_BASE` before regenerating.
- `scripts/build-llms.ts`: generated `llms-full.txt` includes fork regeneration
  guidance so one-shot ingestion carries the rule too.

## Scoped Counts Kept

Counts remain where they are part of a benchmark, concrete case study, or
script-derived operational path. Examples:

- README BrainBench metrics are benchmark claims backed by the sibling eval repo
  and are not skill/test inventory counts.
- `docs/guides/scaling-skills.md` keeps the 306-skill OpenClaw case study
  because the guide is about that specific scaling example.
- `docs/RELEASING.md` keeps diff-aware E2E wording that points to
  `scripts/select-e2e.ts` instead of maintaining a manual E2E file count.

## Verification Intent

The validation for this slice should search current operational docs and
generated-map sources for the removed stale phrases, regenerate the LLM maps,
and inspect the resulting diff for docs-only scope.
