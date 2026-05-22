---
name: skillify
version: 1.0.0
description: |
  The meta skill. Turn any raw feature or script into a properly-skilled,
  tested, resolvable, evaled unit of agent-visible capability. Use when
  the user says "skillify this", "is this a skill?", "make this proper",
  or after a new feature is built without the full skill infrastructure.

  Paired with `gbrain check-resolvable`, skillify gives a user-controllable
  equivalent of Hermes' auto-skill-creation: you build, skillify checks the
  checklist, check-resolvable verifies nothing is orphaned. The human keeps
  judgment; the tooling keeps the checklist honest.
triggers:
  - "skillify this"
  - "skillify"
  - "is this a skill?"
  - "make this proper"
  - "add tests and evals for this"
  - "check skill completeness"
tools:
  - search
  - list_pages
mutating: false
---

# Skillify — The Meta Skill

## Contract

A feature is "properly skilled" when all ten checklist items are present:

1. `SKILL.md` — skill file with YAML frontmatter, triggers, contract, phases.
2. Code — deterministic script if applicable.
3. Unit tests — cover every branch of deterministic logic.
4. Integration tests — exercise live endpoints, not just in-memory shape.
5. LLM evals — quality/correctness cases if the feature includes any LLM call.
6. Resolver trigger — `skills/RESOLVER.md` entry with the trigger patterns
   the user actually types.
7. Resolver trigger eval — test that feeds trigger phrases to the resolver
   and asserts they route to this skill, not the old pre-skillify path.
8. Check-resolvable — `gbrain check-resolvable` passes (skill is reachable,
   MECE against its siblings, no DRY violations).
9. E2E test — exercises the full pipeline from user turn to side effect.
10. Brain filing — if the feature writes brain pages, `brain/RESOLVER.md`
    has an entry for the directory so the pages aren't orphaned.

## Trigger

- "skillify this" / "skillify" / "is this a skill?" / "make this proper"
- "add tests and evals for this"
- After building any new feature that touches user-facing behavior
- When you grep the repo and notice a script with no SKILL.md next to it

## Phases

### Phase 1: Audit what exists

For the feature being skillified, answer:

- **Feature name**: what does it do in one line?
- **Code path**: where does the implementation live (file path)?
- **Checklist status**: run `gbrain skillify check <path>` (preferred)
  or the legacy `scripts/skillify-check.ts <path>` shim. Both produce
  the same 10-item scorecard. Note which items are missing.

### Phase 2: Create missing pieces in order

**Fast path — brand-new skill:** run `gbrain skillify scaffold <name>
--description "..." [--triggers "p1,p2,p3"] [--writes-pages --writes-to
"people/,companies/"]`. This creates all 5 stub files atomically and
appends an idempotent resolver row. Every scaffolded file carries the
`SKILLIFY_STUB` sentinel; `gbrain check-resolvable --strict` will fail
CI until you replace the stubs with real content.

**Manual path — extending an existing skill:** work the list top-down.
Each earlier item constrains what later items look like (the SKILL.md
contract determines what tests assert; tests determine what evals gate;
the resolver entry determines what trigger-eval checks).

1. Write `SKILL.md` first. Frontmatter must include `name`, `version`,
   `description`, `triggers[]`, `tools[]`, `mutating`. Body has at minimum
   Contract, Phases, and Output Format sections.
2. Extract deterministic code into a script if applicable (scripts/*.ts
   for gbrain; host projects may use .mjs / .py / whatever their runtime
   uses).
3. Write unit tests for every branch of the script. Mock external calls
   (LLM, DB, network) so tests run fast and deterministic.
4. Add integration tests that hit real endpoints. These catch bugs the
   unit tests' mocks hide (see the `files-test-reimplements-production`
   learning: reimplementation in tests lets production vulnerabilities
   slip through).
5. Add LLM evals if the feature includes any LLM call. Even a three-case
   eval (happy / edge / adversarial) is cheap insurance against prompt
   regressions.
6. Add the resolver trigger to `skills/RESOLVER.md`. Use the trigger
   patterns the user ACTUALLY types, not what you think they should type.
7. Add a resolver trigger eval that feeds those patterns in and asserts
   they route to the new skill.
8. Run `gbrain check-resolvable` (auto-detects skill trees) or
   `gbrain check-resolvable --skills-dir <path>` for custom locations.
   OpenClaw workspaces are auto-detected from
   `~/.openclaw/workspace/skills/`. The check validates reachability (is
   the skill mentioned from RESOLVER.md?), MECE overlap (does it duplicate
   an existing skill's trigger?), gap detection (are there user intents
   that fall through the resolver with no match?), and DRY. If it fails,
   fix the skill (or extend an existing one instead of creating a
   duplicate).
9. Add an E2E smoke test. For gbrain: submit a Minion job or run a CLI
   invocation end-to-end against a fixture brain; assert side effects.
10. Update `brain/RESOLVER.md` if the skill writes brain pages. Orphaned
    brain pages are worse than no brain pages.

### Phase 3: Verify

Run each of these and confirm green:

```bash
# Unit tests
bun test test/<skill-name>.test.ts

# Integration tests (when applicable)
bun run test:e2e

# Resolver reachability + MECE + DRY
gbrain check-resolvable

# Conformance tests (skill YAML + required sections)
bun test test/skills-conformance.test.ts
```

## Quality gates

A feature is NOT properly skilled until:

- All tests pass (unit + integration + evals).
- It appears in `skills/RESOLVER.md` with accurate trigger patterns.
- The resolver trigger eval confirms patterns route to the new skill.
- `gbrain check-resolvable` shows no orphaned skills, no MECE overlaps,
  no DRY violations.
- If it writes brain pages, `brain/RESOLVER.md` has the directory.

## Anti-Patterns

- ❌ Code with no SKILL.md — invisible to the resolver; the agent will
  never run it.
- ❌ SKILL.md with no tests — untested contract; one prompt change
  regresses silently.
- ❌ Tests that reimplement production code — the reimplementation's
  bugs don't catch production's bugs (the `files-test-reimplements-
  production` lesson).
- ❌ Resolver entry that uses internal jargon the user never types —
  trigger patterns must mirror real user language.
- ❌ Feature that writes to brain without a `brain/RESOLVER.md` entry —
  orphaned pages the agent will never find.
- ❌ Deterministic logic in LLM space — should be a script.
- ❌ LLM judgment in deterministic space — should be an eval.

## Why skillify + check-resolvable is the right pair

Hermes and similar agent frameworks auto-create skills as a background
behavior. That's fine until you don't know what the agent shipped —
checklists decay, tests drift, resolver entries get stale.

Gbrain ships the same capability as two user-controlled tools:

- `/skillify` builds the checklist and helps you fill in the gaps.
- `gbrain check-resolvable` validates the whole skill tree: reachability,
  MECE, DRY, gap detection, orphaned skills.

You decide when and what. The human keeps judgment. The tooling keeps the
checklist honest. In practice this combo produces zero orphaned skills,
every feature with tests + evals + resolver triggers + evals of the
triggers.

## Output Format

A skillify run produces, in order:

1. An audit printout listing which of the 10 items exist and which are
   missing for the target feature.
2. The files created to close each gap (SKILL.md, test files, resolver
   entries).
3. The final `gbrain check-resolvable` output confirming reachability.
4. A one-line summary of the resulting skill completeness score (N/10).
