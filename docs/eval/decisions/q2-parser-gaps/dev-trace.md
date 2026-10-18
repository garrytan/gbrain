# Q2 Track C: development mechanism trace

Where did set H's current employers go? On fresh development phrasings, the build that set H measured (`583a851ee`)
loses a current employer from the default `get_links` read in two ways, and neither is the one the published summary
suggests. A current employer whose stint resumed after an idiomatic leave is **closed** by the new leave cue because the
restart wording is not a start cue (5 of 7 lost edges; the edge stays typed `works_at`, so the live read shows only the
`mentions` row). A new investor spelling on one dated timeline line **attaches** to the link on the next dated line and
outranks `works_at` by verb precedence (2 of 7). Stated types, pack rules and role priors played no part.

Development data only: temporal-edges dev seeds 3 and 5, phrasing sets A, A2 and A3, and eight new phrasing files
written for this trace (`test/fixtures/q2-dev-phrasings/`). No custodian or sealed text was read.

## Setup

- Builds: gbrain master `c5fb0201` (the Track C base), `583a851ee` (set H's build) and `27b1b6af` (= `780a4fc5^`, the
  last state before the amendment-3 removal). `583a851ee` and `27b1b6af` have identical `src/core/link-extraction.ts`
  and `src/core/link-temporal-evidence.ts`; master differs from both by exactly the `git show 780a4fc5` diff in those
  files, so every difference below comes from the removed rules.
- Metrics: gbrain-evals `eval/runner/temporal-edges.ts` on branch `capy/q2-parser-gaps`, `--seeds 3,5 --e5-probe
  --pack eval/data/p3-single-value/works-at-one-per-from.yaml --single-value-pass`, with `--phrasing A|A2|A3` or a
  development phrasing file (`--dev-phrasing-file`, patched locally the way the harness lane adds it).
- Edge identity: `bun scripts/q2-typing-dev.ts dump` writes the same worlds through `put_page` on each build and
  records every person page's link rows (type, source, tense, context), its `link_transitions` rows and its default
  `get_links` read; `compare` prints type steals and transitions by identity against the generator ledger.

New development phrasings (each a full `PhrasingTemplates` file):

| File | Shapes |
|---|---|
| `role-for` | "<role> for <company>" (current, join, move) |
| `new-chapter` | a join described as starting a new chapter |
| `paren-move` | a move or join with the role in parentheses; "now at [X] (<role>)" |
| `signed-on` | "signed on with [X] as <role>"; "serves as an adviser to"; split-object leave |
| `adviser` | "is an adviser to"; "now advising [X]" |
| `board-investor` | "took a board seat at [X] as an investor"; observer at a board meeting; advisory board |
| `leave-start-idioms` | quitting idioms, an exchange move, "first day at", "began working at"; "traded shares of" and "first day of the [X] summit" look-alikes |
| `onboarding` | onboarding starts, "stepped back from", "parted company with"; an onboarding call as a look-alike |

## Lost current employers, by mechanism

A lost edge is a current employer (ledger) that master's default `get_links` lists as `works_at` and `583a851ee`'s
does not. 11 phrasing sets × 2 seeds, 2,552 person pages per build (232 per phrasing set, E5 probe people included).

| Mechanism | Lost | Where | Detail |
|---|---|---|---|
| Stated type or pack rule (`link-extraction.ts` ~708) | 0 | — | no relation lines in prose renders; every base-pack rule is `ner_only` |
| Attachment (`attachedVerb`) + `VERB_RULES` precedence | 2 | A2 s5, board-investor s5 (same person) | "…'s Series B as an angel investor" / "…as an investor" on the line before "Was hired by [Stark] as VP engineering": the new `INVESTED_RE` alternatives match, no link sits between the match and [Stark], so the match attaches, and `invested_in` outranks the `works_at` that master found after the link ("VP engineering") |
| Role prior | 0 | — | |
| Temporal evidence | 5 | onboarding s3 ×2, s5 ×3 | a rejoined current stint: "Parted company with [X]" or "Stepped back from [X]" (new end cues) dates the earlier exit, the later restart "Onboarding week at [X] as …" is not a start cue on any build, so the relationship stays closed. Master recognized neither, so the edge stayed undated and live. The end transitions are correct by identity; the missing restart is missing on both builds |
| Live-read visibility of an unchanged edge | 0 | — | |

Every "lost" edge shows up in the live read of `583a851ee` as a `mentions` row only, which is how the published summary
("typed `mentions` where master typed `works_at`") reads when seen from `get_links`. On development text, 5 of 7 are a
temporal closure, not a typing change.

## Type steals and transitions by identity (583a851ee vs master)

A steal is a person→company pair where the build drops a type the ledger supports or adds one it does not.

| Phrasing | Steals | Gains | New wrong transitions | Correct transitions fixed | Missing correct | Live lost / gained |
|---|---|---|---|---|---|---|
| A | 0 | 0 | 0 | 0 | 0 | 0 / 0 |
| A2 | 8 | 37 | 0 | 29 | 1 | 1 / 0 |
| A3 | 0 | 85 | 0 | 81 | 0 | 0 / 69 |
| role-for | 0 | 0 | 0 | 0 | 0 | 0 / 0 |
| new-chapter | 0 | 24 | 0 | 24 | 0 | 0 / 0 |
| paren-move | 0 | 0 | 0 | 0 | 0 | 0 / 0 |
| signed-on | 0 | 0 | 0 | 35 | 0 | 0 / 0 |
| adviser | 0 | 52 | 0 | 0 | 0 | 0 / 0 |
| board-investor | 23 | 0 | 0 | 0 | 1 | 1 / 0 |
| leave-start-idioms | 0 | 0 | 0 | 300 | 0 | 0 / 0 |
| onboarding | 0 | 24 | 0 | 198 | 0 | 5 / 0 |

The 31 steals, by cause:

| Cause | Pairs | Ledger relation of the pair |
|---|---|---|
| investor spelling ("as an angel investor", "as an investor") on another dated line attaches across the line break | 16 | advisee 10, current employer 6 |
| observer or board wording ("…board meeting as an observer") types `invested_in` | 15 | former employer (an alumni-trap line) 15 |

The three published set-H shapes did not reproduce a loss: "<role> for <company>", "(<role>)" after a move and most
"new chapter" joins type `mentions` on **both** builds (live recall 0.640, 0.597 and 0.597 on master and `583a851ee`
alike), because the removed `ROLE_AT_RE` reads "<role> at" and "as <role>", not "for" or parentheses. They are recall
gaps, not regressions.

Runner metrics that moved (seeds 3 and 5; master → `583a851ee`):

| Phrasing | live recall | as-of exact | advisor traps | investment traps | alumni traps | E5 extra starts | E5 wrong closures |
|---|---|---|---|---|---|---|---|
| A | 0.871 → 0.871 | 0.933 → 0.933 | 28/28 | 26/26 | 20/20 | 48 → 0 | 24 → 0 |
| A2 | 0.827 → 0.820 | 0.892 → 0.900 | 28/28 | 26/26 | 20/20 | 48 → 0 | 24 → 0 |
| A3 | 0.633 → 0.827 | 0.648 → 0.790 | 28/28 | 26/26 | 20/20 | 21 → 0 | 8 → 0 |
| signed-on | 0.583 → 0.583 | 0.579 → 0.612 | 0/28 → 0/28 | 22 → 26/26 | 18 → 20/20 | 16 → 0 | 7 → 0 |
| adviser | 0.871 → 0.871 | 0.883 → 0.915 | 0/28 → 28/28 | 26/26 | 20/20 | 48 → 0 | 24 → 0 |
| board-investor | 0.871 → 0.863 | 0.933 → 0.929 | 28/28 | 26/26 | 20/20 | 72 → 0 | 36 → 0 |
| leave-start-idioms | 0.871 → 0.871 | 0.750 → 0.863 | 28/28 | 17 → 20/26 | 14 → 19/20 | 0 → 0 | 0 → 0 |
| onboarding | 0.633 → 0.597 | 0.598 → 0.698 | 28/28 | 17 → 26/26 | 14 → 20/20 | 0 → 0 | 0 → 0 |

`583a851ee` also applied 5 single-value closures on leave-start-idioms (`sv_wrong_closures` 0 → 5/160).

## What the units change because of this

- **U3** adds no investor or observer spelling to `INVESTED_RE`. Its only typing changes are suppressions (board,
  observer and investor wording never types `works_at`; "board seat at" keeps `invested_in` only with an investor
  prior), so it cannot produce the cross-line `invested_in` steal. Observer wording stays `mentions`.
- **U5** (leave idioms and exchange moves) gets a restart guard: an end it adds is dropped when a later dated line
  refers to the same organization in plain words that no cue reads (a possible unrecognized rejoin), outside event and
  qualified lines. Without it, U5 reproduces the onboarding losses.
- **U6** covers the restart framings the trace found ("onboarding week at", "onboarded at", "first day at", "began
  working at", "kicked off a new role at", "a new chapter at").
- **U2** targets the shapes that were recall gaps on every build ("<role> for", "(<role>)" after the link, "as <role>"
  after a join, move, sign-on or new chapter), on the link's own line only, so a role on another timeline line never
  attaches.
- **U1** carries the `adviser` spelling and "advising [X]"; the signed-on and adviser sets show master at 0/28 advisor
  traps for those spellings.
- **U3/U4 dependency:** see `dev-units.md` (board-director development phrasing). The trace above has no board line that
  master types `works_at`, so it cannot show the set-F interaction by itself.

Reproduce (from a gbrain checkout with gbrain-evals beside it):

```bash
bun eval/runner/temporal-edges.ts --gbrain ../gbrain@583a851ee --seeds 3,5 --e5-probe \
  --pack eval/data/p3-single-value/works-at-one-per-from.yaml --single-value-pass \
  --dev-phrasing-file ../gbrain/test/fixtures/q2-dev-phrasings/onboarding.json --output /tmp/te   # in gbrain-evals
bun scripts/q2-typing-dev.ts dump --evals ../gbrain-evals --root ../gbrain-evals/.gbrain-overlays/583a851ee \
  --phrasing test/fixtures/q2-dev-phrasings/onboarding.json --out /tmp/583.json                      # in gbrain
bun scripts/q2-typing-dev.ts compare --base /tmp/master.json --arm /tmp/583.json
```
