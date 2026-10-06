# P5 delta preregistration: pieces landed after the frozen build

Decision id `p5-delta-2026-10-05`. Recorded on 2026-10-05, before any sealed data for these pieces was opened. The
first sealed run (`../p5-dev-2026-10-04/preregistration.md`) decides wanted pages, the typed line grammar, the
similar-page hint and per-edge verb attachment at frozen build `21befeb5b`. This run decides only what changed after
it. Sealed runs are executed by the custodian only; the custodian pins the delta build SHA at confirmation.

## What the delta covers and the default each verdict decides

| Piece | Config key | Default if the bar passes | If it fails |
|---|---|---|---|
| Validity ranges on typed relation lines stored as dated edge transitions (producer `inline`, `src/core/link-effective.ts`) | `line_grammar.effective_ranges` | on | off (ships off) |
| Wanted rows recorded on the remote `put_page` write path (link-effect hook, `runLinksEffect`) | `wanted_pages.remote` | on | off (ships off) |
| Temporal-evidence lexicon: an advisory, board or investor role ("Took an advisory role with [X]", "Became an advisor at [X]") is not an employment start (`NOT_EMPLOYMENT_ROLE` guard on the `took … role` and `became … at/of` alternatives of `EMPLOYMENT.start` in `src/core/link-temporal-evidence.ts`) | none (evidence derivation) | kept | reverted before landing |
| Link typing changes made when the edge-validity schema merged: the verb is read at the link's own position in the window; links joined only by commas or conjunctions share the verb before the first; a verb followed by a preposition and the next link belongs to that link | none (extraction behavior) | kept | reverted to the frozen build's typing before landing |

## Hypotheses, metrics and bars

**H7, validity ranges.** Same delta build, two arms: `line_grammar.effective_ranges` off and on. Corpus: the
temporal-edges category's held-out stints (custodian mode), written as typed relation lines with
`@effective[start,end)` ranges instead of dated timeline prose. Questions: current employer/advisor (live reads) and
"where did X work on date D" (`as_of` reads). Metric: answer accuracy per question, clustered by person.
Bars: as_of accuracy on − off ≥ +10 points with the 95% CI lower bound > 0; current-state accuracy no lower than off
by more than 1 point; pages with no ranges produce identical `link_transitions` in both arms (exact).

**H8, remote wanted rows.** H4's sequential-write runner over the HTTP transport (remote `put_page`), seeded shuffled
write order, withheld-entity variant. Metric: withheld-entity recall in `wanted_pages`, edges recovered once targets
appear. Bars: recall ≥ 0.95, within 0.02 of the local arm, non-entity noise 0 (exact).

**H9, typing changes.** Frozen build `21befeb5b` extractor vs delta build extractor, the same pages. Corpus: the
seeded relation-line-variants world (world-v1 rendered with relation lines, held-out generator seeds outside 1–3) and
the temporal-edges held-out set. Metrics: `anyTypeMatch` per gold edge and live-
relationship accuracy. Bars: noninferior at tolerance 0.01 on both.

**H10, temporal-evidence lexicon.** The edge-validity plan's temporal-edges held-out set C (custodian mode), run as a
noninferiority guard on every gate that plan preregistered, plus the retrieval-feedback plan's E5 wrong-closure probe
(pages with one long employment stint and a later dated "Took an advisory role with [X]" or "Became an advisor at
[X]" line on a page that also asserts works_at to X). Arms: the delta build vs the same build with the guard removed. Gate: `e5_extra_works_at_starts`,
delta vs no-guard on set C, bar 0 (exact); every edge-validity gate noninferior at tolerance 0.01. Report, not gate:
`e5_wrong_closures` on the retrieval-feedback plan's build with and without the guard, once that plan's PR is on
master (its single-value rule lives there). Run by the custodian (P0).

Guardrails: LongMemEval-S `recall_all@5` noninferior (tolerance 0.01); N4 resolver no new wrong merge (exact).

## Amendments (2026-10-05, before any sealed cell of this run or the remaining first-run cells was opened)

1. **Delta build re-frozen at `011bd0b6a`** (was `0a967e5d5`). The rule that dropped a `mentions` edge next to a typed
   edge to the same target is removed: the custodian's dev H9 run traced all 7 lost edges of 840 (mean −0.008 against
   the 0.01 tolerance) to it, and its only benefit was strict F1. Keeping it would have put the other three typing
   changes at risk of reversion on a narrow margin.
2. **H10 gate.** `e5_extra_works_at_starts`, delta vs no-guard on set C, bar 0. The delta build declares no single-value
   rule (`cardinality` lives on the retrieval-feedback plan's branch), so wrong closures are reported, not gated, on
   that plan's build with and without the guard once it is on master.
3. **H9 corpus.** "Held-out world-v1 seeds" means the seeded relation-line-variants world.

Custodian dev numbers recorded before freezing (dev data only): H7 as-of accuracy on range pages 0.175 → 1.000 with
prose pages unchanged; H10's guard removes 48 of 48 false employment starts, and on the retrieval-feedback build
wrong closures go 24/72 without the guard to 0/72 with it; H9 at `0a967e5d5` lost 7 of 840 edges (mean −0.008), all
from the rule removed in amendment 1.

## Amendment 2 (2026-10-05, before set G or any H11 cell was opened)

1. **Delta build re-frozen at `970c3088b`** (was `011bd0b6a`; the remote wanted-rows hook measured by H8 is in it too).
   The second custodian's held-out set F showed that the `NOT_EMPLOYMENT_ROLE` guard alone made as-of exactness worse
   (0.553 with the guard, 0.642 without) while cutting wrong closures 23 → 0: link typing still marked a company named
   only in a dated board or advisory line as `works_at`, so the undated edge stayed live at every date. Two fixes went in
   without seeing set F:
   - **Link typing.** Board roles resolve to `invested_in` on a page describing an investor and to `advises` otherwise;
     observer and investor roles type `invested_in`; "advising" counts as advises. No board, advisory, investor or
     observer phrasing types `works_at`.
   - **Temporal cue families** (from the edge-validity plan's set E finding, traps 89/105): onboarding-style starts,
     leave phrases whose object splits the verb, and exchange moves ("traded [A] for [B]" ends A and starts B), with
     negative controls ("traded shares of [X]" is not a move). The guard is unchanged.
2. **H10 re-check** on a fresh set G written by the second custodian: `e5_extra_works_at_starts` = 0, every
   edge-validity gate noninferior to master at tolerance 0.01, and as-of exactness on set G not below the no-guard arm.
3. **H11, temporal cue coverage.** The edge-validity plan's E1 gates on set G: traps ≥ 0.99, every other gate
   noninferior to master at tolerance 0.01. Run by the second custodian.
4. **H9** now also covers the board/advisory typing change (frozen extractor vs `970c3088b`, same corpus and bar).

Dev numbers at `970c3088b` (dev data only): world-v1 type accuracy 0.774 (0.753 at `011bd0b6a`, 0.767 at the frozen
build), strict F1 0.196. Edge-validity dev split (seeds 3 and 5, phrasing set A), master `cab092f5c` vs `970c3088b`:
traps 1.000 / 1.000, as-of exact 0.900 / 0.933, during F1 0.896 / 0.921, live recall 0.842 / 0.871, now recall
0.842 / 0.867, correction ok 0.867 / 1.000, invariant 1.000 / 1.000, now precision 1.000 / 1.000.

## Amendment 3 (2026-10-05, cycle 2, before set H was opened)

1. **Delta build re-frozen at `583a851ee`** (was `970c3088b`). Set G (second custodian) passed the guard itself
   (0 extra employment starts and 0 wrong closures, against 11 and 6 with no guard) but failed H10 and H11:
   current-employer recall 0.650 → 0.594 and live-edge recall 0.606 → 0.545 against master, and H11 traps 104/113
   (bar 0.99). Without seeing set G:
   - **Typing:** an ordinary role before "at" ("senior designer at [X]", "led engineering at [X]") and a join or move
     ending "as <role>" ("joined [X] as CTO", "moved to [X] as head of sales") type `works_at`. Board, advisory,
     investor and observer roles keep their types. "advising" counts as advises only as a relationship verb.
   - **Temporal cues:** quitting idioms with a particle or object in the middle, and starts framed as a first day or
     kick-off, with event look-alikes as negative controls.
2. **H10 and H11 retest on a fresh set H** from the second custodian. Bars are the same as amendment 2: H10
   `e5_extra_works_at_starts` = 0, every edge-validity gate noninferior to master at 0.01, current-employer and
   live-edge recall noninferior to master at 0.01; H11 traps ≥ 0.99 and every other gate noninferior to master.
3. **Cycle limit.** This is the second cycle. If set H fails either H10 or H11, the post-freeze link-typing and
   temporal-lexicon changes are removed before landing and the edge-validity plan's master behavior stands.

Dev numbers at `583a851ee` (dev data only): world-v1 type accuracy 0.774, strict F1 0.196. Edge-validity dev split,
master `4022fd7c5` vs `583a851ee`: traps 1.000 / 1.000, as-of exact 0.900 / 0.933, during F1 0.896 / 0.921, live
recall 0.842 / 0.871, now recall 0.842 / 0.867, correction ok 0.867 / 1.000.

## Dev disclosures

Dev world-v1 (seeds 1–3 only, never sealed): type accuracy 0.767 at the frozen build, 0.753 at the delta build,
0.747 on master with the edge-validity schema; strict F1 0.195, 0.191 and 0.188 (0.217 at `0a967e5d5`, before
amendment 1 removed the mention-drop rule). The 0.014 type-accuracy drop comes from two
edges on one page ("advisor at [A], [B], and [C]") that the coordination rule types `advises` while world-v1's gold,
built from the generator's ledger, says `invested_in`. H7 dev: `test/link-effective.test.ts` shows an ended range
hides the edge from default reads and `as_of` finds it.

## Runner pieces the custodian needs (not built by the implementer)

1. H7: a temporal-edges variant writer that renders held-out stints as relation lines with ranges, and an arm switch
   for `line_grammar.effective_ranges` on category runners (they take `search.*` pins only today).
2. H8: H4's sequential-write runner with an HTTP-transport arm.
3. H9: a type-accuracy runner that imports an overlay build's extractor (`--gbrain`) and writes receipt rows.
4. H10: the temporal-edges set C runner in custodian mode with every edge-validity gate, the E5 wrong-closure probe,
   and a no-guard arm (the delta build with `NOT_EMPLOYMENT_ROLE` removed).
5. H10 re-check and H11: set G (second custodian) through the temporal-edges custodian mode, scoring every E1 gate,
   `e5_extra_works_at_starts` and as-of exactness, with master and no-guard arms.

## Budget

H7 and H9 are deterministic ($0). H8 is deterministic ($0). Guardrails ≈ $10 in embeddings. Within the P5 cap.
