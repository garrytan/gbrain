# Q2 Track C: typing units on development data

U1 (adviser wording) and the joint unit U34 (U3 board wording never types `works_at`, U4 advisory, board and investor
roles are not employment starts) ship: the preregistered held-out decision confirmed the package P2 = {U3, U4, U1}
(`afcec1ad`), and `ENABLED_TYPING_UNITS` is `[U3, U4, U1]`. U6 failed the safety conditions at held-out selection on I1 and W1 (now-recall
−0.012, as-of exact −0.011, one new wrong transition by identity), and U25 (U2 with U5) added nothing on the
confirmation set (difference 0.000 on all 200 pairs). Following the preregistration, the U2, U5 and U6 code was removed
before landing, and the landing head types identically to `afcec1ad` (see "Landing equivalence").

The rest of this report is the development record written before the verdict: all six units were measured alone and
together on development data. After reworks, no unit had a development type steal or a new wrong transition by
identity, and the all-unit package removed every E5 false start and every wrong single-value closure while adding 73
current employers to the live read. The development data showed two dependencies, recorded as joint units: **U34** (U4
needs U3) and **U25** (U2 needs U5). Development gains did not predict held-out ones for U2, U5 and U6.

## Landing equivalence

The landing head (the U2, U5 and U6 code, their examples and the U25 alias removed; U1, U3, U4, U34, the rule ids,
`explainLinkType` and the package script kept) was compared with the confirmed package `afcec1ad`, both at their
built-in `ENABLED_TYPING_UNITS = [U3, U4, U1]`, with zero differences:

- **world-v1** (`scripts/q2-typing-dev.ts world-v1`, every page's extracted edges, tense rows and transitions): 723
  lines, SHA-256 `1763359f75ac050fc19e8fdd17a6694a8cf0e6a7fbd12c2b01ef5932f9ef96fd` on both, byte-identical files. The
  digest is committed in `test/fixtures/q2-typing-units/world-v1-confirmed-package.sha256` and checked by
  `test/link-typing-units-subsets.test.ts`.
- **Development dumps** (`scripts/q2-typing-dev.ts dump`, pages written through `put_page` on in-memory PGLite;
  every person page's link rows with type, source, tense and context, its `link_transitions` rows, and its default
  `get_links` read), compared row for row and with `compare` by identity: 0 differing pages, 0 steals, 0 gains, 0
  transition differences on every phrasing.

| Phrasing (seeds 3, 5) | Person pages | Link rows | Transitions | Pages that differ |
|---|---|---|---|---|
| A | 232 | 1,024 | 1,056 | 0 |
| A2 | 232 | 987 | 978 | 0 |
| A3 | 232 | 847 | 830 | 0 |
| role-for | 232 | 848 | 571 | 0 |
| new-chapter | 232 | 869 | 464 | 0 |
| paren-move | 232 | 825 | 777 | 0 |
| signed-on | 232 | 839 | 734 | 0 |
| adviser | 232 | 1,024 | 1,004 | 0 |
| board-investor | 232 | 1,024 | 978 | 0 |
| board-director | 232 | 990 | 982 | 0 |
| leave-start-idioms | 232 | 1,003 | 464 | 0 |
| onboarding | 232 | 894 | 464 | 0 |

`src/core/link-extraction.ts` and `src/core/link-temporal-evidence.ts` on the landing head are byte-identical to
their state at `0044223c` (after U4, before U2), which is also why the outputs match: the removed code was reachable
only through `typingUnitEnabled('U2' | 'U5' | 'U6')`, which the package never enabled.

Development data only: temporal-edges dev seeds 3 and 5 with phrasing sets A, A2, A3 and the nine
`test/fixtures/q2-dev-phrasings/` files; world-v1 (H1 runner); relation-line variants dev seeds 1-3 (H2 runner). No
custodian or sealed text was read. Mechanism background: `dev-trace.md`.

## Units, rules and commits

| Unit | Commit(s) | Change | Dev rework |
|---|---|---|---|
| U1 adviser wording | `c1b3233f`, `61934b56` | `adviser` spelling, "advising [X]", local negation, third-party veto | adviser phrase on another entry (window edge) vetoed: it caused 6 steals on signed-on |
| U2 ordinary roles | `1b5a8569` | post-pass where inference returned `mentions`: "<role> for", "led <area> at", "[X] (<role>)", "as <role>" after a join | undated lines only; not on a page that names an advisory/board/investor role; not for an organization two or more dated entries mention |
| U3 board wording | `dd05898d` | board/observer/investor wording vetoes `works_at`; board seat keeps `invested_in` only with an investor prior or a stated investment | veto scoped to the link's own sentence/entry or a board position right before the link (first version stole jobs a neighboring entry's verb had typed) |
| U4 not-employment starts | `0044223c` | `NOT_EMPLOYMENT_ROLE` in the "became … at/of" and "took … role" start cues | none; joint with U3 as U34 (`30717952`) |
| U5 leave idioms | `fe4c334e`, `5a9efd08` | split-object and quitting idioms, "exit from", exchange moves; dated ends only | restart guard (from the trace): an idiom end is dropped when a later dated entry names the organization in words no cue reads; share-trade lines ("Traded shares of [X]") no longer count, because they made the guard drop correct ends (investment traps 17/26 → 16/26 on leave-start-idioms before the fix, 26/26 after) |
| U6 start framings | `fd0b1f55`, `c6655db2` | first day/week, day one, kick-off with a job noun, onboarded/onboarding week, began working at, new chapter at | leave guard (mirror of U5's) and the advisory-page guard: alone it had opened former jobs for good (6-8 wrong general single-value closures, 5-24 wrong E5 closures, lower traps) |

Infrastructure: `efd1628e` (rule ids, `explainLinkType`), `192c0870` (unit plumbing, example harness), `30717952`
(package script, U34 alias, 64-subset and world-v1 identity tests), `49b1ae6e` (entailment table and recipe).

## Dependencies the development data shows

- **U4 needs U3 (set-F interaction, confirmed).** On the board-director phrasing, board lines that master types
  `works_at` lose their start under U4 and read as a job on every date: as-of exact 0.946 (master) → 0.783 (U4 alone),
  during-F1 0.931 → 0.890. U3 alone gives 0.950, U3 with U4 0.950. U4 alone would fail the as-of safety gate wherever
  board wording types `works_at`; U3 alone does not need U4. The freeze record should declare **U34** joint, with U4's
  primary metric (preregistration, "What is decided").
- **U2 and U6 expose master's advisory-line start cues.** A newly typed (U2) or newly dated (U6) employer meets the
  false `works_at` start that master's "became … at" / "took … role" cue reads on an advisory line about another
  target (E5 "other" form); the single-value pass then closes the real employer on the advisory date, a new wrong
  closure by identity. U4 removes the cause. I kept U2 and U6 independent of U4 with a page-level guard (they do not
  fire on a page that names any organization in an advisory, board or investor role); the cost is that a person with
  an advisory role elsewhere gets no U2 typing or U6 dating. Kept as built (decision of 2026-10-06).
- **Count-based E5 metric hides wrong starts.** `e5_extra_works_at_starts` is zero-clamped and counts starts: on
  master a missed correct start masks a wrong advisory start, so a unit that recovers the correct start shows a "new"
  extra start without adding a wrong transition. The identity tables below are the faithful measure (plan §9.3).

## Dependency units

The preregistration amendment records two joint units, each measured with the primary metric of its first member.

**U34 = U3 with U4** (U4's primary metric, false employment starts per E5 probe person). On board-director, U4 alone
takes as-of exact from 0.946 to 0.783 and during-F1 from 0.931 to 0.890: board lines that master types `works_at` lose
their start and read as a job on every date. U3 removes the `works_at` typing; U3 with U4 gives 0.950 and 0.940.

**U25 = U2 with U5** (U2's primary metric, live-edge recall). U2 types the current employer in "[X] (<role>)" and
"signed on with [X] as <role>" prose. When the former employer's leave is an idiom only U5 reads ("Exit from [Y]",
"Handed in her notice at [Y]"), master keeps the former employer live, and with a dated start for the newly typed
employer the general single-value pass closes the former employer at that start date instead of its real end: a new
wrong closure by identity (by date). U5 dates the real leave, so the relationship is already closed and the pass has
nothing to close.

| Phrasing | Arm | live recall | as-of exact | now-precision | investment traps | alumni traps | general single-value wrong closures |
|---|---|---|---|---|---|---|---|
| paren-move | none | 0.597 | 0.640 | 0.793 | 22/26 | 18/20 | 3/160 |
| paren-move | U2 | 0.734 | 0.727 | 0.858 | 22/26 | 18/20 | **4/160** |
| paren-move | U5 | 0.597 | 0.671 | 0.958 | 26/26 | 20/20 | 0/160 |
| paren-move | U25 | **0.741** | 0.760 | 1.000 | 26/26 | 20/20 | **0/160** |
| signed-on | none | 0.583 | 0.579 | 0.737 | 22/26 | 18/20 | 3/160 |
| signed-on | U2 | 0.727 | 0.673 | 0.806 | 22/26 | 18/20 | **4/160** |
| signed-on | U5 | 0.583 | 0.612 | 0.874 | 26/26 | 20/20 | 0/160 |
| signed-on | U25 | **0.734** | 0.708 | 0.933 | 26/26 | 20/20 | **0/160** |
| role-for | none / U2 / U25 | 0.640 / 0.727 / 0.727 | 0.637 / 0.683 / 0.683 | 0.934 / 0.979 / 0.979 | 26/26 | 20/20 | 0/160 |
| new-chapter | none / U2 / U25 | 0.597 / 0.741 / 0.741 | 0.535 / 0.623 / 0.623 | 0.755 / 0.816 / 0.816 | 19/26 | 16/20 | 0/160 |

By identity, U25 against no unit: no steals, no new wrong transitions, 12-21 current employers added to the live read
on role-for, new-chapter, paren-move and signed-on, and 44-165 correct transitions added (U5's ends). U25's live-edge
recall equals or exceeds U2's on every phrasing (the extra 0.007 on paren-move and signed-on is an employer U5's
end/start pair now keeps live), and on the eight phrasings without these role shapes it changes nothing U5 alone does
not. The package of the amended family, {U1, U25, U34, U6} = all six units, is the "all" arm in the tables below and passes the
frozen examples (`test/q2-typing-package.test.ts`); `bun scripts/q2-typing-package.ts --base <ref> --arm U25` and
`--units U25,U1,U34,U6` build its refs.

## Identity tables (all phrasings, both seeds, arm vs no unit)

Steal: a person-company pair that lost a ledger type or gained more unsupported types than it shed. Transitions by
identity (subject, target, type, kind, date) against the generator ledger; dumps written through `put_page` without the
single-value pass (`scripts/q2-typing-dev.ts`).

| arm | steals | gains | other moves | new wrong transitions | wrong transitions removed | correct transitions added | correct transitions lost | current employers lost from live read | added to live read |
|---|---|---|---|---|---|---|---|---|---|
| U1 | 0 | 176 | 21 | 0 | 0 | 72 | 0 | 0 | 0 |
| U2 | 0 | 73 | 0 | 0 | 0 | 27 | 0 | 0 | 73 |
| U3 | 0 | 0 | 28 | 0 | 28 | 0 | 0 | 0 | 0 |
| U4 | 0 | 0 | 0 | 0 | 570 | 0 | 0 | 0 | 0 |
| U34 | 0 | 0 | 28 | 0 | 570 | 0 | 0 | 0 | 0 |
| U5 | 0 | 0 | 0 | 0 | 0 | 331 | 0 | 0 | 0 |
| U25 | 0 | 73 | 0 | 0 | 0 | 358 | 0 | 0 | 73 |
| U6 | 0 | 0 | 0 | 0 | 0 | 61 | 0 | 0 | 0 |
| all | 0 | 249 | 49 | 0 | 570 | 718 | 0 | 0 | 73 |

Correct `works_at` transitions by identity, starts · ends · wrong transitions (all works_at starts and ends not in the
ledger), per phrasing (seeds 3 and 5; 496 ledger starts, 285 ledger ends):

| phrasing | none | U1 | U2 | U3 | U4 | U34 | U5 | U25 | U6 | all |
|---|---|---|---|---|---|---|---|---|---|---|
| A | 475/496 · 282/285 · 48 | 475/496 · 282/285 · 48 | 475/496 · 282/285 · 48 | 475/496 · 282/285 · 48 | 475/496 · 282/285 · 0 | 475/496 · 282/285 · 0 | 475/496 · 282/285 · 48 | 475/496 · 282/285 · 48 | 475/496 · 282/285 · 48 | 475/496 · 282/285 · 0 |
| A2 | 444/496 · 261/285 · 48 | 444/496 · 261/285 · 48 | 444/496 · 261/285 · 48 | 444/496 · 261/285 · 48 | 444/496 · 261/285 · 0 | 444/496 · 261/285 · 0 | 444/496 · 261/285 · 48 | 444/496 · 261/285 · 48 | 444/496 · 261/285 · 48 | 444/496 · 261/285 · 0 |
| A3 | 338/496 · 219/285 · 37 | 338/496 · 219/285 · 37 | 338/496 · 219/285 · 37 | 338/496 · 219/285 · 37 | 338/496 · 219/285 · 0 | 338/496 · 219/285 · 0 | 338/496 · 219/285 · 37 | 338/496 · 219/285 · 37 | 338/496 · 219/285 · 37 | 338/496 · 219/285 · 0 |
| role-for | 231/496 · 241/285 · 37 | 231/496 · 241/285 · 37 | 231/496 · 241/285 · 37 | 231/496 · 241/285 · 37 | 231/496 · 241/285 · 0 | 231/496 · 241/285 · 0 | 231/496 · 241/285 · 37 | 231/496 · 241/285 · 37 | 231/496 · 241/285 · 37 | 231/496 · 241/285 · 0 |
| new-chapter | 231/496 · 157/285 · 33 | 231/496 · 157/285 · 33 | 231/496 · 157/285 · 33 | 231/496 · 157/285 · 33 | 231/496 · 157/285 · 0 | 231/496 · 157/285 · 0 | 231/496 · 157/285 · 33 | 231/496 · 157/285 · 33 | 243/496 · 157/285 · 33 | 257/496 · 157/285 · 0 |
| paren-move | 330/496 · 186/285 · 33 | 330/496 · 186/285 · 33 | 342/496 · 186/285 · 33 | 330/496 · 186/285 · 33 | 330/496 · 186/285 · 0 | 330/496 · 186/285 · 0 | 330/496 · 218/285 · 33 | 342/496 · 218/285 · 33 | 330/496 · 186/285 · 33 | 342/496 · 218/285 · 0 |
| signed-on | 339/496 · 186/285 · 33 | 339/496 · 186/285 · 33 | 354/496 · 186/285 · 33 | 339/496 · 186/285 · 33 | 339/496 · 186/285 · 0 | 339/496 · 186/285 · 0 | 339/496 · 221/285 · 33 | 354/496 · 221/285 · 33 | 339/496 · 186/285 · 33 | 354/496 · 221/285 · 0 |
| adviser | 475/496 · 282/285 · 48 | 475/496 · 282/285 · 48 | 475/496 · 282/285 · 48 | 475/496 · 282/285 · 48 | 475/496 · 282/285 · 0 | 475/496 · 282/285 · 0 | 475/496 · 282/285 · 48 | 475/496 · 282/285 · 48 | 475/496 · 282/285 · 48 | 475/496 · 282/285 · 0 |
| board-investor | 475/496 · 282/285 · 72 | 475/496 · 282/285 · 72 | 475/496 · 282/285 · 72 | 475/496 · 282/285 · 72 | 475/496 · 282/285 · 0 | 475/496 · 282/285 · 0 | 475/496 · 282/285 · 72 | 475/496 · 282/285 · 72 | 475/496 · 282/285 · 72 | 475/496 · 282/285 · 0 |
| board-director | 479/496 · 282/285 · 100 | 479/496 · 282/285 · 100 | 479/496 · 282/285 · 100 | 479/496 · 282/285 · 72 | 479/496 · 282/285 · 0 | 479/496 · 282/285 · 0 | 479/496 · 282/285 · 100 | 479/496 · 282/285 · 100 | 479/496 · 282/285 · 100 | 479/496 · 282/285 · 0 |
| leave-start-idioms | 231/496 · 157/285 · 48 | 231/496 · 157/285 · 48 | 231/496 · 157/285 · 48 | 231/496 · 157/285 · 48 | 231/496 · 157/285 · 0 | 231/496 · 157/285 · 0 | 282/496 · 271/285 · 48 | 282/496 · 271/285 · 48 | 258/496 · 157/285 · 48 | 383/496 · 280/285 · 0 |
| onboarding | 231/496 · 157/285 · 33 | 231/496 · 157/285 · 33 | 231/496 · 157/285 · 33 | 231/496 · 157/285 · 33 | 231/496 · 157/285 · 0 | 231/496 · 157/285 · 0 | 231/496 · 256/285 · 33 | 231/496 · 256/285 · 33 | 253/496 · 157/285 · 33 | 361/496 · 278/285 · 0 |

## Runner metrics (temporal-edges, seeds 3 and 5, `--e5-probe --pack works-at-one-per-from --single-value-pass`)

Primary metrics on development data:

| Unit | Primary metric | Development effect |
|---|---|---|
| U1 | advisor-trap accuracy | signed-on 0/28 → 28/28, adviser 0/28 → 28/28; flat elsewhere |
| U2 (U25) | live-edge recall | role-for 0.640 → 0.727, new-chapter 0.597 → 0.741, paren-move 0.597 → 0.734, signed-on 0.583 → 0.727; flat elsewhere |
| U3 (U34) | investment-trap accuracy | flat on every phrasing (no development investment line is typed `works_at` by board wording); board-director live recall 0.712 → 0.899, now-precision 0.766 → 1.000 |
| U4 (U34) | false employment starts per E5 probe person | removes all 33-100 wrong starts per phrasing (identity); E5 extra starts and E5 wrong closures 0 on every phrasing |
| U5 | correct end transitions | paren-move 186 → 218/285, signed-on 186 → 221, leave-start-idioms 157 → 271, onboarding 157 → 256 |
| U6 | correct start transitions | new-chapter 231 → 243/496, leave-start-idioms 231 → 258, onboarding 231 → 253 |

Residuals the safety conditions may see:

- **U2 alone, general single-value pass:** +1 wrong closure on paren-move and on signed-on. Resolved by the joint unit
  U25 (next section); U2 is no longer measured alone.
- **U6 alone:** as-of exact moves by -0.002 to -0.004 on three phrasings (new-chapter 0.535 → 0.531, onboarding
  0.598 → 0.596; leave-start-idioms during-F1 0.819 → 0.815): a correctly dated restart hides an earlier stint whose
  start no cue reads. No new wrong transition by identity.
- Trap counts: after U5's share-trade rework no unit lowers any trap family on any phrasing; U5 raises investment and
  alumni traps where leaves were unread (leave-start-idioms 17 → 26/26 and 14 → 20/20).

Full per-arm runner tables (refs built by `scripts/q2-typing-package.ts`; U2, U3, U4, U34 and U6 on `c6655db2`, U1 on
`61934b56`, U5, U25 and all units ({U1, U25, U34, U6}) on `5a9efd08`):

#### A

| arm | live recall | as-of exact | during F1 | now prec. | now recall | advisor traps | investment traps | alumni traps | E5 extra starts | E5 wrong closures | general SV wrong closures |
|---|---|---|---|---|---|---|---|---|---|---|---|
| none | 0.871 | 0.933 | 0.921 | 1.000 | 0.867 | 28/28 | 26/26 | 20/20 | 48/72 | 24/72 | 0/160 |
| U1 | 0.871 | 0.933 | 0.921 | 1.000 | 0.867 | 28/28 | 26/26 | 20/20 | 48/72 | 24/72 | 0/160 |
| U2 | 0.871 | 0.933 | 0.921 | 1.000 | 0.867 | 28/28 | 26/26 | 20/20 | 48/72 | 24/72 | 0/160 |
| U3 | 0.871 | 0.933 | 0.921 | 1.000 | 0.867 | 28/28 | 26/26 | 20/20 | 48/72 | 24/72 | 0/160 |
| U4 | 0.871 | 0.933 | 0.921 | 1.000 | 0.867 | 28/28 | 26/26 | 20/20 | 0/72 | 0/72 | 0/160 |
| U34 | 0.871 | 0.933 | 0.921 | 1.000 | 0.867 | 28/28 | 26/26 | 20/20 | 0/72 | 0/72 | 0/160 |
| U5 | 0.871 | 0.933 | 0.921 | 1.000 | 0.867 | 28/28 | 26/26 | 20/20 | 48/72 | 24/72 | 0/160 |
| U25 | 0.871 | 0.933 | 0.921 | 1.000 | 0.867 | 28/28 | 26/26 | 20/20 | 48/72 | 24/72 | 0/160 |
| U6 | 0.871 | 0.933 | 0.921 | 1.000 | 0.867 | 28/28 | 26/26 | 20/20 | 48/72 | 24/72 | 0/160 |
| all | 0.871 | 0.933 | 0.921 | 1.000 | 0.867 | 28/28 | 26/26 | 20/20 | 0/72 | 0/72 | 0/160 |

#### A2

| arm | live recall | as-of exact | during F1 | now prec. | now recall | advisor traps | investment traps | alumni traps | E5 extra starts | E5 wrong closures | general SV wrong closures |
|---|---|---|---|---|---|---|---|---|---|---|---|
| none | 0.827 | 0.892 | 0.890 | 1.000 | 0.829 | 28/28 | 26/26 | 20/20 | 48/72 | 24/72 | 0/160 |
| U1 | 0.827 | 0.892 | 0.890 | 1.000 | 0.829 | 28/28 | 26/26 | 20/20 | 48/72 | 24/72 | 0/160 |
| U2 | 0.827 | 0.892 | 0.890 | 1.000 | 0.829 | 28/28 | 26/26 | 20/20 | 48/72 | 24/72 | 0/160 |
| U3 | 0.827 | 0.892 | 0.890 | 1.000 | 0.829 | 28/28 | 26/26 | 20/20 | 48/72 | 24/72 | 0/160 |
| U4 | 0.827 | 0.892 | 0.890 | 1.000 | 0.829 | 28/28 | 26/26 | 20/20 | 0/72 | 0/72 | 0/160 |
| U34 | 0.827 | 0.892 | 0.890 | 1.000 | 0.829 | 28/28 | 26/26 | 20/20 | 0/72 | 0/72 | 0/160 |
| U5 | 0.827 | 0.892 | 0.890 | 1.000 | 0.829 | 28/28 | 26/26 | 20/20 | 48/72 | 24/72 | 0/160 |
| U25 | 0.827 | 0.892 | 0.890 | 1.000 | 0.829 | 28/28 | 26/26 | 20/20 | 48/72 | 24/72 | 0/160 |
| U6 | 0.827 | 0.892 | 0.890 | 1.000 | 0.829 | 28/28 | 26/26 | 20/20 | 48/72 | 24/72 | 0/160 |
| all | 0.827 | 0.892 | 0.890 | 1.000 | 0.829 | 28/28 | 26/26 | 20/20 | 0/72 | 0/72 | 0/160 |

#### A3

| arm | live recall | as-of exact | during F1 | now prec. | now recall | advisor traps | investment traps | alumni traps | E5 extra starts | E5 wrong closures | general SV wrong closures |
|---|---|---|---|---|---|---|---|---|---|---|---|
| none | 0.633 | 0.648 | 0.628 | 0.886 | 0.642 | 28/28 | 26/26 | 20/20 | 21/72 | 8/72 | 0/160 |
| U1 | 0.633 | 0.692 | 0.642 | 0.958 | 0.642 | 28/28 | 26/26 | 20/20 | 21/72 | 8/72 | 0/160 |
| U2 | 0.633 | 0.648 | 0.628 | 0.886 | 0.642 | 28/28 | 26/26 | 20/20 | 21/72 | 8/72 | 0/160 |
| U3 | 0.633 | 0.648 | 0.628 | 0.886 | 0.642 | 28/28 | 26/26 | 20/20 | 21/72 | 8/72 | 0/160 |
| U4 | 0.633 | 0.648 | 0.628 | 0.886 | 0.642 | 28/28 | 26/26 | 20/20 | 0/72 | 0/72 | 0/160 |
| U34 | 0.633 | 0.648 | 0.628 | 0.886 | 0.642 | 28/28 | 26/26 | 20/20 | 0/72 | 0/72 | 0/160 |
| U5 | 0.633 | 0.648 | 0.628 | 0.886 | 0.642 | 28/28 | 26/26 | 20/20 | 21/72 | 8/72 | 0/160 |
| U25 | 0.633 | 0.648 | 0.628 | 0.886 | 0.642 | 28/28 | 26/26 | 20/20 | 21/72 | 8/72 | 0/160 |
| U6 | 0.633 | 0.648 | 0.628 | 0.886 | 0.642 | 28/28 | 26/26 | 20/20 | 21/72 | 8/72 | 0/160 |
| all | 0.633 | 0.692 | 0.642 | 0.958 | 0.642 | 28/28 | 26/26 | 20/20 | 0/72 | 0/72 | 0/160 |

#### role-for

| arm | live recall | as-of exact | during F1 | now prec. | now recall | advisor traps | investment traps | alumni traps | E5 extra starts | E5 wrong closures | general SV wrong closures |
|---|---|---|---|---|---|---|---|---|---|---|---|
| none | 0.640 | 0.637 | 0.648 | 0.934 | 0.640 | 28/28 | 26/26 | 20/20 | 0/72 | 0/72 | 0/160 |
| U1 | 0.640 | 0.637 | 0.648 | 0.934 | 0.640 | 28/28 | 26/26 | 20/20 | 0/72 | 0/72 | 0/160 |
| U2 | 0.727 | 0.683 | 0.715 | 0.979 | 0.724 | 28/28 | 26/26 | 20/20 | 0/72 | 0/72 | 0/160 |
| U3 | 0.640 | 0.637 | 0.648 | 0.934 | 0.640 | 28/28 | 26/26 | 20/20 | 0/72 | 0/72 | 0/160 |
| U4 | 0.640 | 0.637 | 0.648 | 0.934 | 0.640 | 28/28 | 26/26 | 20/20 | 0/72 | 0/72 | 0/160 |
| U34 | 0.640 | 0.637 | 0.648 | 0.934 | 0.640 | 28/28 | 26/26 | 20/20 | 0/72 | 0/72 | 0/160 |
| U5 | 0.640 | 0.637 | 0.648 | 0.934 | 0.640 | 28/28 | 26/26 | 20/20 | 0/72 | 0/72 | 0/160 |
| U25 | 0.727 | 0.683 | 0.715 | 0.979 | 0.724 | 28/28 | 26/26 | 20/20 | 0/72 | 0/72 | 0/160 |
| U6 | 0.640 | 0.637 | 0.648 | 0.934 | 0.640 | 28/28 | 26/26 | 20/20 | 0/72 | 0/72 | 0/160 |
| all | 0.727 | 0.683 | 0.715 | 0.979 | 0.724 | 28/28 | 26/26 | 20/20 | 0/72 | 0/72 | 0/160 |

#### new-chapter

| arm | live recall | as-of exact | during F1 | now prec. | now recall | advisor traps | investment traps | alumni traps | E5 extra starts | E5 wrong closures | general SV wrong closures |
|---|---|---|---|---|---|---|---|---|---|---|---|
| none | 0.597 | 0.535 | 0.552 | 0.755 | 0.602 | 28/28 | 19/26 | 16/20 | 0/72 | 0/72 | 0/160 |
| U1 | 0.597 | 0.573 | 0.565 | 0.819 | 0.602 | 28/28 | 19/26 | 16/20 | 0/72 | 0/72 | 0/160 |
| U2 | 0.741 | 0.623 | 0.656 | 0.816 | 0.753 | 28/28 | 19/26 | 16/20 | 0/72 | 0/72 | 0/160 |
| U3 | 0.597 | 0.535 | 0.552 | 0.755 | 0.602 | 28/28 | 19/26 | 16/20 | 0/72 | 0/72 | 0/160 |
| U4 | 0.597 | 0.535 | 0.552 | 0.755 | 0.602 | 28/28 | 19/26 | 16/20 | 0/72 | 0/72 | 0/160 |
| U34 | 0.597 | 0.535 | 0.552 | 0.755 | 0.602 | 28/28 | 19/26 | 16/20 | 0/72 | 0/72 | 0/160 |
| U5 | 0.597 | 0.535 | 0.552 | 0.755 | 0.602 | 28/28 | 19/26 | 16/20 | 0/72 | 0/72 | 0/160 |
| U25 | 0.741 | 0.623 | 0.656 | 0.816 | 0.753 | 28/28 | 19/26 | 16/20 | 0/72 | 0/72 | 0/160 |
| U6 | 0.597 | 0.531 | 0.552 | 0.755 | 0.602 | 28/28 | 19/26 | 16/20 | 0/72 | 0/72 | 0/160 |
| all | 0.741 | 0.660 | 0.669 | 0.869 | 0.753 | 28/28 | 19/26 | 16/20 | 0/72 | 0/72 | 0/160 |

#### paren-move

| arm | live recall | as-of exact | during F1 | now prec. | now recall | advisor traps | investment traps | alumni traps | E5 extra starts | E5 wrong closures | general SV wrong closures |
|---|---|---|---|---|---|---|---|---|---|---|---|
| none | 0.597 | 0.640 | 0.608 | 0.793 | 0.602 | 28/28 | 22/26 | 18/20 | 14/72 | 5/72 | 3/160 |
| U1 | 0.597 | 0.640 | 0.608 | 0.793 | 0.602 | 28/28 | 22/26 | 18/20 | 14/72 | 5/72 | 3/160 |
| U2 | 0.734 | 0.727 | 0.712 | 0.858 | 0.744 | 28/28 | 22/26 | 18/20 | 14/72 | 5/72 | 4/160 |
| U3 | 0.597 | 0.640 | 0.608 | 0.793 | 0.602 | 28/28 | 22/26 | 18/20 | 14/72 | 5/72 | 3/160 |
| U4 | 0.597 | 0.640 | 0.608 | 0.793 | 0.602 | 28/28 | 22/26 | 18/20 | 0/72 | 0/72 | 3/160 |
| U34 | 0.597 | 0.640 | 0.608 | 0.793 | 0.602 | 28/28 | 22/26 | 18/20 | 0/72 | 0/72 | 3/160 |
| U5 | 0.597 | 0.671 | 0.623 | 0.958 | 0.602 | 28/28 | 26/26 | 20/20 | 14/72 | 5/72 | 0/160 |
| U25 | 0.741 | 0.760 | 0.727 | 1.000 | 0.753 | 28/28 | 26/26 | 20/20 | 14/72 | 5/72 | 0/160 |
| U6 | 0.597 | 0.640 | 0.608 | 0.793 | 0.602 | 28/28 | 22/26 | 18/20 | 14/72 | 5/72 | 3/160 |
| all | 0.741 | 0.760 | 0.727 | 1.000 | 0.753 | 28/28 | 26/26 | 20/20 | 0/72 | 0/72 | 0/160 |

#### signed-on

| arm | live recall | as-of exact | during F1 | now prec. | now recall | advisor traps | investment traps | alumni traps | E5 extra starts | E5 wrong closures | general SV wrong closures |
|---|---|---|---|---|---|---|---|---|---|---|---|
| none | 0.583 | 0.579 | 0.583 | 0.737 | 0.589 | 0/28 | 22/26 | 18/20 | 16/72 | 7/72 | 3/160 |
| U1 | 0.583 | 0.629 | 0.598 | 0.791 | 0.589 | 28/28 | 22/26 | 18/20 | 16/72 | 7/72 | 3/160 |
| U2 | 0.727 | 0.673 | 0.693 | 0.806 | 0.738 | 0/28 | 22/26 | 18/20 | 16/72 | 7/72 | 4/160 |
| U3 | 0.583 | 0.579 | 0.583 | 0.737 | 0.589 | 0/28 | 22/26 | 18/20 | 16/72 | 7/72 | 3/160 |
| U4 | 0.583 | 0.579 | 0.583 | 0.737 | 0.589 | 0/28 | 22/26 | 18/20 | 0/72 | 0/72 | 3/160 |
| U34 | 0.583 | 0.579 | 0.583 | 0.737 | 0.589 | 0/28 | 22/26 | 18/20 | 0/72 | 0/72 | 3/160 |
| U5 | 0.583 | 0.612 | 0.598 | 0.874 | 0.589 | 0/28 | 26/26 | 20/20 | 16/72 | 7/72 | 0/160 |
| U25 | 0.734 | 0.708 | 0.708 | 0.933 | 0.747 | 0/28 | 26/26 | 20/20 | 16/72 | 7/72 | 0/160 |
| U6 | 0.583 | 0.579 | 0.583 | 0.737 | 0.589 | 0/28 | 22/26 | 18/20 | 16/72 | 7/72 | 3/160 |
| all | 0.734 | 0.758 | 0.723 | 1.000 | 0.747 | 28/28 | 26/26 | 20/20 | 0/72 | 0/72 | 0/160 |

#### adviser

| arm | live recall | as-of exact | during F1 | now prec. | now recall | advisor traps | investment traps | alumni traps | E5 extra starts | E5 wrong closures | general SV wrong closures |
|---|---|---|---|---|---|---|---|---|---|---|---|
| none | 0.871 | 0.883 | 0.906 | 0.945 | 0.867 | 0/28 | 26/26 | 20/20 | 48/72 | 24/72 | 0/160 |
| U1 | 0.871 | 0.933 | 0.921 | 1.000 | 0.867 | 28/28 | 26/26 | 20/20 | 48/72 | 24/72 | 0/160 |
| U2 | 0.871 | 0.883 | 0.906 | 0.945 | 0.867 | 0/28 | 26/26 | 20/20 | 48/72 | 24/72 | 0/160 |
| U3 | 0.871 | 0.883 | 0.906 | 0.945 | 0.867 | 0/28 | 26/26 | 20/20 | 48/72 | 24/72 | 0/160 |
| U4 | 0.871 | 0.883 | 0.906 | 0.945 | 0.867 | 0/28 | 26/26 | 20/20 | 0/72 | 0/72 | 0/160 |
| U34 | 0.871 | 0.883 | 0.906 | 0.945 | 0.867 | 0/28 | 26/26 | 20/20 | 0/72 | 0/72 | 0/160 |
| U5 | 0.871 | 0.883 | 0.906 | 0.945 | 0.867 | 0/28 | 26/26 | 20/20 | 48/72 | 24/72 | 0/160 |
| U25 | 0.871 | 0.883 | 0.906 | 0.945 | 0.867 | 0/28 | 26/26 | 20/20 | 48/72 | 24/72 | 0/160 |
| U6 | 0.871 | 0.883 | 0.906 | 0.945 | 0.867 | 0/28 | 26/26 | 20/20 | 48/72 | 24/72 | 0/160 |
| all | 0.871 | 0.933 | 0.921 | 1.000 | 0.867 | 28/28 | 26/26 | 20/20 | 0/72 | 0/72 | 0/160 |

#### board-investor

| arm | live recall | as-of exact | during F1 | now prec. | now recall | advisor traps | investment traps | alumni traps | E5 extra starts | E5 wrong closures | general SV wrong closures |
|---|---|---|---|---|---|---|---|---|---|---|---|
| none | 0.871 | 0.933 | 0.921 | 1.000 | 0.867 | 28/28 | 26/26 | 20/20 | 72/72 | 36/72 | 0/160 |
| U1 | 0.871 | 0.933 | 0.921 | 1.000 | 0.867 | 28/28 | 26/26 | 20/20 | 72/72 | 36/72 | 0/160 |
| U2 | 0.871 | 0.933 | 0.921 | 1.000 | 0.867 | 28/28 | 26/26 | 20/20 | 72/72 | 36/72 | 0/160 |
| U3 | 0.871 | 0.933 | 0.921 | 1.000 | 0.867 | 28/28 | 26/26 | 20/20 | 72/72 | 36/72 | 0/160 |
| U4 | 0.871 | 0.933 | 0.921 | 1.000 | 0.867 | 28/28 | 26/26 | 20/20 | 0/72 | 0/72 | 0/160 |
| U34 | 0.871 | 0.933 | 0.921 | 1.000 | 0.867 | 28/28 | 26/26 | 20/20 | 0/72 | 0/72 | 0/160 |
| U5 | 0.871 | 0.933 | 0.921 | 1.000 | 0.867 | 28/28 | 26/26 | 20/20 | 72/72 | 36/72 | 0/160 |
| U25 | 0.871 | 0.933 | 0.921 | 1.000 | 0.867 | 28/28 | 26/26 | 20/20 | 72/72 | 36/72 | 0/160 |
| U6 | 0.871 | 0.933 | 0.921 | 1.000 | 0.867 | 28/28 | 26/26 | 20/20 | 72/72 | 36/72 | 0/160 |
| all | 0.871 | 0.933 | 0.921 | 1.000 | 0.867 | 28/28 | 26/26 | 20/20 | 0/72 | 0/72 | 0/160 |

#### board-director

| arm | live recall | as-of exact | during F1 | now prec. | now recall | advisor traps | investment traps | alumni traps | E5 extra starts | E5 wrong closures | general SV wrong closures |
|---|---|---|---|---|---|---|---|---|---|---|---|
| none | 0.712 | 0.946 | 0.931 | 0.766 | 0.719 | 0/28 | 26/26 | 20/20 | 72/72 | 36/72 | 26/160 |
| U1 | 0.712 | 0.946 | 0.931 | 0.766 | 0.719 | 0/28 | 26/26 | 20/20 | 72/72 | 36/72 | 26/160 |
| U2 | 0.712 | 0.946 | 0.931 | 0.766 | 0.719 | 0/28 | 26/26 | 20/20 | 72/72 | 36/72 | 26/160 |
| U3 | 0.899 | 0.950 | 0.940 | 1.000 | 0.896 | 0/28 | 26/26 | 20/20 | 72/72 | 36/72 | 0/160 |
| U4 | 0.899 | 0.783 | 0.890 | 0.803 | 0.896 | 0/28 | 26/26 | 20/20 | 0/72 | 0/72 | 0/160 |
| U34 | 0.899 | 0.950 | 0.940 | 1.000 | 0.896 | 0/28 | 26/26 | 20/20 | 0/72 | 0/72 | 0/160 |
| U5 | 0.712 | 0.946 | 0.931 | 0.766 | 0.719 | 0/28 | 26/26 | 20/20 | 72/72 | 36/72 | 26/160 |
| U25 | 0.712 | 0.946 | 0.931 | 0.766 | 0.719 | 0/28 | 26/26 | 20/20 | 72/72 | 36/72 | 26/160 |
| U6 | 0.712 | 0.946 | 0.931 | 0.766 | 0.719 | 0/28 | 26/26 | 20/20 | 72/72 | 36/72 | 26/160 |
| all | 0.899 | 0.950 | 0.940 | 1.000 | 0.896 | 0/28 | 26/26 | 20/20 | 0/72 | 0/72 | 0/160 |

#### leave-start-idioms

| arm | live recall | as-of exact | during F1 | now prec. | now recall | advisor traps | investment traps | alumni traps | E5 extra starts | E5 wrong closures | general SV wrong closures |
|---|---|---|---|---|---|---|---|---|---|---|---|
| none | 0.871 | 0.750 | 0.819 | 0.787 | 0.867 | 28/28 | 17/26 | 14/20 | 0/72 | 0/72 | 0/160 |
| U1 | 0.871 | 0.750 | 0.819 | 0.787 | 0.867 | 28/28 | 17/26 | 14/20 | 0/72 | 0/72 | 0/160 |
| U2 | 0.871 | 0.750 | 0.819 | 0.787 | 0.867 | 28/28 | 17/26 | 14/20 | 0/72 | 0/72 | 0/160 |
| U3 | 0.871 | 0.750 | 0.819 | 0.787 | 0.867 | 28/28 | 17/26 | 14/20 | 0/72 | 0/72 | 0/160 |
| U4 | 0.871 | 0.750 | 0.819 | 0.787 | 0.867 | 28/28 | 17/26 | 14/20 | 0/72 | 0/72 | 0/160 |
| U34 | 0.871 | 0.750 | 0.819 | 0.787 | 0.867 | 28/28 | 17/26 | 14/20 | 0/72 | 0/72 | 0/160 |
| U5 | 0.871 | 0.821 | 0.897 | 1.000 | 0.867 | 28/28 | 26/26 | 20/20 | 0/72 | 0/72 | 0/160 |
| U25 | 0.871 | 0.821 | 0.897 | 1.000 | 0.867 | 28/28 | 26/26 | 20/20 | 0/72 | 0/72 | 0/160 |
| U6 | 0.871 | 0.750 | 0.815 | 0.787 | 0.867 | 28/28 | 17/26 | 14/20 | 0/72 | 0/72 | 0/160 |
| all | 0.871 | 0.912 | 0.918 | 1.000 | 0.867 | 28/28 | 26/26 | 20/20 | 0/72 | 0/72 | 0/160 |

#### onboarding

| arm | live recall | as-of exact | during F1 | now prec. | now recall | advisor traps | investment traps | alumni traps | E5 extra starts | E5 wrong closures | general SV wrong closures |
|---|---|---|---|---|---|---|---|---|---|---|---|
| none | 0.633 | 0.598 | 0.635 | 0.655 | 0.633 | 28/28 | 17/26 | 14/20 | 0/72 | 0/72 | 0/160 |
| U1 | 0.633 | 0.635 | 0.648 | 0.697 | 0.633 | 28/28 | 17/26 | 14/20 | 0/72 | 0/72 | 0/160 |
| U2 | 0.633 | 0.598 | 0.635 | 0.655 | 0.633 | 28/28 | 17/26 | 14/20 | 0/72 | 0/72 | 0/160 |
| U3 | 0.633 | 0.598 | 0.635 | 0.655 | 0.633 | 28/28 | 17/26 | 14/20 | 0/72 | 0/72 | 0/160 |
| U4 | 0.633 | 0.598 | 0.635 | 0.655 | 0.633 | 28/28 | 17/26 | 14/20 | 0/72 | 0/72 | 0/160 |
| U34 | 0.633 | 0.598 | 0.635 | 0.655 | 0.633 | 28/28 | 17/26 | 14/20 | 0/72 | 0/72 | 0/160 |
| U5 | 0.633 | 0.631 | 0.708 | 0.900 | 0.633 | 28/28 | 26/26 | 20/20 | 0/72 | 0/72 | 0/160 |
| U25 | 0.633 | 0.631 | 0.708 | 0.900 | 0.633 | 28/28 | 26/26 | 20/20 | 0/72 | 0/72 | 0/160 |
| U6 | 0.633 | 0.596 | 0.631 | 0.655 | 0.633 | 28/28 | 17/26 | 14/20 | 0/72 | 0/72 | 0/160 |
| all | 0.633 | 0.785 | 0.752 | 0.958 | 0.633 | 28/28 | 26/26 | 20/20 | 0/72 | 0/72 | 0/160 |

## world-v1 (H1 runner, grammar on)

| arm | type accuracy | any-type match | edges correctly typed newly | edges no longer correctly typed | pages grammar on/off differ |
|---|---|---|---|---|---|
| none | 0.7534246575342466 | 0.9452054794520548 | 0 | 0 (any-type lost 0) | 0/240 |
| U1 | 0.7602739726027398 | 0.9452054794520548 | 1 | 0 (any-type lost 0) | 0/240 |
| U2 | 0.7534246575342466 | 0.9452054794520548 | 0 | 0 (any-type lost 0) | 0/240 |
| U3 | 0.7671232876712328 | 0.9452054794520548 | 2 | 0 (any-type lost 0) | 0/240 |
| U4 | 0.7534246575342466 | 0.9452054794520548 | 0 | 0 (any-type lost 0) | 0/240 |
| U34 | 0.7671232876712328 | 0.9452054794520548 | 2 | 0 (any-type lost 0) | 0/240 |
| U5 | 0.7534246575342466 | 0.9452054794520548 | 0 | 0 (any-type lost 0) | 0/240 |
| U6 | 0.7534246575342466 | 0.9452054794520548 | 0 | 0 (any-type lost 0) | 0/240 |
| all | 0.773972602739726 | 0.9452054794520548 | 3 | 0 (any-type lost 0) | 0/240 |

No arm loses an edge master typed correctly; any-type match is unchanged (0.945) and grammar on/off parity stays
240/240. With no unit, `scripts/q2-typing-dev.ts world-v1` reproduces master `c5fb0201`'s digest
(`ce8f52bd…`, committed in `test/fixtures/q2-typing-units/world-v1-master.sha256` and checked by
`test/link-typing-units-subsets.test.ts`). The all-unit package changes 7 of 725 extraction lines: U3 drops two
board-worded `works_at` (and their tense rows), and U1 types one "Started advising [X]" occurrence `advises` (with its
dated start) where the investor role prior had typed it `invested_in`. H1 counts all three as newly correct.

## Relation-line variants (H2 runner, dev seeds 1-3, grammar on, `--type-rows`)

| arm | relation-line typed recall | decoy types reached | type rows: correctly typed | relation rows lost vs none | edge rows no longer correctly typed | edge rows newly correct |
|---|---|---|---|---|---|---|
| none | 1.000 | 34/120 | 0.442 | 0 | 0 | 0 |
| U1 | 1.000 | 34/120 | 0.444 | 0 | 0 | 2 |
| U2 | 1.000 | 34/120 | 0.442 | 0 | 0 | 0 |
| U3 | 1.000 | 34/120 | 0.448 | 0 | 0 | 5 |
| U4 | 1.000 | 34/120 | 0.442 | 0 | 0 | 0 |
| U34 | 1.000 | 34/120 | 0.448 | 0 | 0 | 5 |
| U5 | 1.000 | 34/120 | 0.442 | 0 | 0 | 0 |
| U6 | 1.000 | 34/120 | 0.442 | 0 | 0 | 0 |
| all | 1.000 | 34/120 | 0.450 | 0 | 0 | 7 |

Relation-line typed recall stays 1.000, no decoy type is added by any arm (decoy_types_added_by_grammar 0), and no
arm loses a relation line or a correctly typed world-v1 edge.

## Reproduce

```bash
bun scripts/q2-typing-package.ts --base <ref> --arm U2            # or --units U1,U2,U34,U5,U6
bun eval/runner/temporal-edges.ts --gbrain ../gbrain@<sha> --seeds 3,5 --e5-probe \
  --pack eval/data/p3-single-value/works-at-one-per-from.yaml --single-value-pass \
  --dev-phrasing-file ../gbrain/test/fixtures/q2-dev-phrasings/signed-on.json      # in gbrain-evals
GBRAIN_EVAL_CONFIG=line_grammar.enabled=true bun eval/runner/line-grammar-typing.ts --gbrain ../gbrain@<sha>
GBRAIN_EVAL_CONFIG=line_grammar.enabled=true bun eval/runner/relation-line-variants.ts --seeds 1,2,3 --type-rows --gbrain ../gbrain@<sha>
bun scripts/q2-typing-dev.ts dump --evals ../gbrain-evals --root . --units U2 --phrasing test/fixtures/q2-dev-phrasings/signed-on.json --out /tmp/u2.json
bun scripts/q2-typing-dev.ts compare --base /tmp/none.json --arm /tmp/u2.json
```

`--dev-phrasing-file` was patched into a local gbrain-evals copy the way the harness lane adds it (not yet pushed
there when these runs were made). Zero model calls; no paid run.

## Landing merge (master b5f12b12, v0.60.117.0)

The landing merge brings in master's #6191 (no `works_at` or `founded` inferred toward person, meeting or calendar
targets), which changes link typing for every build. On world-v1, the change from the confirmed package `afcec1ad`
(723 lines, `1763359f…`) to the landing head (706 lines, `02b15d1b…`) is exactly the change from the master `afcec1ad`
was built on (units off, 725 lines, `ce8f52bd…`) to master `b5f12b12` (708 lines, `3222513a…`): 22 lines removed and 5
changed in both, every one a company-to-person `works_at` edge or its tense row, and no other line differs. With no
unit, the landing head types world-v1 byte-identically to master `b5f12b12`. On temporal-edges phrasings A, A2 and A3
(seeds 3 and 5, the harness's `--c-gate` settings) the landing head reproduces the pre-merge numbers exactly, with
units off and with the shipped package: E5 false starts 48/48/37 → 0, E5 wrong closures 24/24/8 → 0, wrong
transitions by identity 89/89/59 → 17/17/14, live recall and traps unchanged, A3 as-of 0.619 → 0.650.

