# P5 delta: held-out verdicts

Each verdict sets the default the preregistration names. Runs by the custodian (P0) and, for sets G and H, the second
custodian.

| Hypothesis | Build | Verdict | Result | Outcome |
|---|---|---|---|---|
| H7, validity ranges on typed relation lines | `970c3088b` | PASS | as-of accuracy on range pages 0.228 → 1.000, 95% CI of the difference [+0.695, +0.846]; prose pages unchanged | `line_grammar.effective_ranges` on by default |
| H8, wanted rows from remote writes | sweep coordinator fix `9d6b789f5` | PASS | HTTP-arm withheld-entity recall 1.000, local arm 1.000 | `wanted_pages.remote` on by default |
| H9, link typing changes (verb at the link's own position, coordinated links share a verb, a verb before a preposition and the next link belongs to that link) | `970c3088b` | PASS on both corpora | noninferior to the frozen extractor | kept, as at `011bd0b6a` |
| N4 resolver guardrail | `970c3088b` | PASS | no new wrong merge; resolver outcomes noninferior | — |
| H10/H11 on set G (cycle 1) | `970c3088b` | FAIL | guard: 0 extra employment starts, 0 wrong closures (11 and 6 without it); current-employer recall 0.650 → 0.594 and live-edge recall 0.606 → 0.545 against master; H11 traps 104/113 | cycle 2 |
| H10/H11 on set H (cycle 2) | `583a851ee` | FAIL | guard: 0 extra starts, 0 wrong closures (24 and 12 without it), as-of equal to no-guard; live-edge recall 0.748 → 0.670 against master, CI [−0.141, −0.015]; H11 traps 85/122 = 0.697 (investment 33/39, alumni 39/47, advisor 13/36 on every build) | removed (amendment 3) |

## Removal under amendment 3

Amendment 3, item 3: "If set H fails either H10 or H11, the post-freeze link-typing and temporal-lexicon changes are
removed before landing and the edge-validity plan's master behavior stands." The amendment does not keep the
`NOT_EMPLOYMENT_ROLE` guard, so it is removed with the rest. Removed: the board/advisory/investor/observer typing
rework, the ordinary-role typing (`ROLE_AT_RE`), and every temporal-lexicon change (the guard, onboarding, split-object
and idiomatic leaves, exchange moves, first-day starts). Link typing is as at `011bd0b6a` (the H9 changes) and
`src/core/link-temporal-evidence.ts` matches master.

## Follow-ups

- Adviser wording in set H is not typed `advises` on any build, master and the pre-edge-validity baseline included.
- Role-carrying employment phrasings still typed `mentions` ("<role> for [X]", "started something new at [X]",
  "moved to [X] (role)") and idiomatic leave phrases the cue lexicon does not read. A future change needs its own
  preregistration and held-out set.

## First run

First-run verdicts are in `../p5-dev-2026-10-04/verdicts.md`. H5b (agent loop duplicates) failed, so
`put_page.similar_pages` is off by default. H3 (junk audit) failed, so `line_grammar.enabled` is off by default and H6
did not run. H7's `line_grammar.effective_ranges` stays on by default and applies once a user turns the grammar on.
