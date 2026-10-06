# P5 first run: held-out verdicts

The custodians ran every first-run cell on frozen build `21befeb5b` against baseline master `6622a119e`, under
`preregistration.md` and its amendments (P0; H3 computed by the second custodian from P0's run). Each verdict sets the default the preregistration's feature table names.
Delta-run verdicts (H7 to H11) are in `../p5-delta-2026-10-05/verdicts.md`.

| Hypothesis | Result | Verdict | Outcome |
|---|---|---|---|
| H1, link typing does not regress (world-v1) | any-type match 0.493 → 0.493; type accuracy 0.747 → 0.767; 240/240 pages extract identically with the grammar on and off | PASS | — |
| H2, written relation types reach the graph (template set B) | typed recall 0.811 → 1.000; 0 of 120 decoy types added | PASS | — |
| H4, forward references heal (local writes) | edges lost 1,849/3,810 → 0/3,738; withheld-entity recall 0 → 1.000 | PASS | `wanted_pages.enabled` on by default |
| H5a, similar-page hint on held-out name pools | lexical recall@3 0 → 0.980; hint on no-referent names 4.7% | PASS | H5b decides the default |
| H5b, agent loop duplicates (Claude Sonnet 5.5 and `gpt-6.1-sol`, 60 held-out tasks each) | duplicate-page rate 3.06% → 2.22% (−27% relative; 95% CI of the difference [−2.8, +1.1] points, crosses 0); wrong-merge rate 2.50% → 3.75% (+1.25 points, 95% CI [−1.25, +3.75], against a bar of at most +1) | FAIL | `put_page.similar_pages` off by default; still available with `gbrain config set put_page.similar_pages true` |
| H3, junk stays out (minted frame, amendment 2) | 18 of 696,295 list lines minted (0.026 per 1,000), all fact lines, no relation lines; precision 0/18 (Wilson 95% [0.00, 0.18]), both judges agreed on every line; zero-tolerance classes clean | FAIL | `line_grammar.enabled` off by default |
| H6, typed lines help answers | | not run | the preregistration runs H6 only if H1 to H3 pass |

## H3

Corpora: LongMemEval-S haystack sessions as markdown (17,319 pages, 668,711 list lines), LoCoMo transcripts (183 pages,
no list lines) and a CC0 public notes vault (1,020 pages, 27,584 list lines). Judges: Claude Sonnet 5.5 and
`gpt-6.1-sol`; a disagreement would have counted as wrong, and there were none.

- **Root cause.** Every minted line is a fact line whose bracketed list prefix is not a category: unfilled template
  slots in schedule skeletons (`- [Time] - [Event]`, 15 lines on two pages) and dictionary usage labels (3 lines on one
  page). The fact-line category rule accepts any single letter-led bracketed word at the start of a list item. A
  placeholder/skeleton guard is the fix; it changes the grammar after the freeze, so it ships in a follow-up with its
  own held-out frame, not in this PR.
- **Denominator.** The frame held only 18 minted lines, so all 18 were labeled instead of the planned 300, and the
  precision interval is wide. It still sits wholly below the bar: the upper bound is 0.18.
- **Zero-tolerance classes.** No line was minted from the 1,714 timecode, 168 citation, 108 task-marker, 76 date and 61
  machine-section list lines.
- **Harness error.** 1 of 18,522 pages (8 list lines) failed the write cross-check. Even if all 8 had minted correctly,
  precision would be 8/26 (Wilson upper bound 0.50), so the verdict cannot change.
- **Consequence.** `line_grammar.enabled` needs H1, H2, H3 and H6, so it ships off by default and H6 does not run. With
  the grammar off, `line_grammar.effective_ranges` (on by default, H7) has nothing to store until a user turns the
  grammar on.

## H5b by model

| Model | Duplicate-page rate | Wrong-merge rate |
|---|---|---|
| Claude Sonnet 5.5 | unchanged | unchanged |
| `gpt-6.1-sol` | 2.8% → 1.1% | 5.0% → 7.5% |

All of the movement is in the GPT arm, where duplicates fell and wrong merges rose. The wrong-merge bar fails, so the
hint ships off by default. The duplicate reduction would not have passed on its own either, since its interval
includes zero.
