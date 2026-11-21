# Finding duplicate people and companies: head-to-head (no automatic people links, 2026-11-20)

- **We learned that a shared profile link or ID is not proof that two pages describe the same person.** gbrain's automatic tier joined 36 of 488 different-person pairs (7.38%) on invented hard cases, while keeping all 188 different-company pairs apart. You should have a person confirm a suggested person match before an agent combines the notes.
- **We learned that a classic probabilistic matcher (Splink, tuned) makes better suggestions than gbrain's proposed tier:** more real duplicates found and fewer wrong joins. We plan to build that method natively rather than add a dependency.
- **We learned that a language-model matcher finds every planted duplicate but joins many different people.** Measure bad merges, not just duplicates found.

These are stress rates on invented hard cases, not rates you'd see in a real brain.

## Question

gbrain's duplicate finder can join pages it is sure describe one entity (the automatic tier) and suggest others for review (the proposed tier). How often does each tier join different people or companies, and does a classic matcher, a memory system or a model matcher do better?

## What was tried

- A preregistered head-to-head in gbrain-evals, run 2026-11-18 to 2026-11-20 under a frozen plan with five amendments. It measured gbrain v0.60.738.0 (`0a008fe5`), arm 7 of an earlier rule study.
- A synthetic world of 2,106 pages (1,576 people, 530 companies) with planted hard cases, 20 instances per case family: 488 must-not-link and 312 must-link person pairs, 188 must-not-link and 124 must-link company pairs. Scoring uses the fixed answer key on final groups, with no model judge.
- The automatic rule needed the same strict name, one page per source and a shared profile or declared ID. The hard cases include the identity failures a rule like that can't see, for example:
  - a recycled login: `alice-example` used a GitHub login years ago, and a different `alice-example` uses it now;
  - a LinkedIn link pasted onto the wrong person's page;
  - a typo in a declared ID that makes it match someone else's.
- Compared against Splink 5.0.0, dedupe 3.0.3, Zingg 0.7.0, four memory systems (named generically on the results page) and three model matchers (claude-opus-5-5, gpt-6.2-sol, particle-1).

## Results

| gbrain v0.60.738.0, arm 7 | People false merges (95%) | People recall | Company false merges | Company recall |
|---|---|---|---|---|
| Automatic tier | 36/488 (7.38%; 5.38% to 10.04%) | 58/312 | 0/188 (0%; 0% to 2.00%) | 27/124 |
| Proposed tier, including automatic | 296/488 (60.66%) | 209/312 | 64/188 (34.04%) | 81/124 |

- **The 36 wrong automatic person joins** came from three families, 12 each: the recycled login, the LinkedIn link on the wrong person and the declared-ID typo.
- **Proposed tier, people and companies combined:** it joined 360 of 676 different pairs and found 290 of 436 true pairs.
- **Tuned Splink's review point** found 326 of 436 true pairs and joined 309 of 676 different pairs: +8.26 recall points (paired 95% interval +4.52 to +12.20) and −7.54 false-merge points against gbrain's proposed tier. It also wins on people alone, but not on companies alone, where it raised false merges from 64 to 98 of 188.
- **Model matchers**, different people joined with a direct "yes" alone: claude-opus-5-5 150/488 (30.74%), particle-1 232/488 (47.54%), gpt-6.2-sol 238/488 (48.77%). None joined different companies. Correct direct decisions: 834, 684 and 656 of 1,059, at $0.09229, $0.00685 and $0.02249 per correct decision. As a review queue, Opus's "unsure" pairs were 1 real of 117, so no model adjudicator is planned.
- Every memory system merged different entities in every scored setting (people false-merge rates 44% to 80%).
- gbrain's contact-key confirm list held 193 entries: 114 real, 79 wrong (40.93%).

Source: the results page [2026-11-18-entity-dedupe-h2h.md](https://github.com/garrytan/gbrain-evals/blob/9af98d9dba49432602537d904178a374d457a2e5/docs/benchmarks/2026-11-18-entity-dedupe-h2h.md), merged in gbrain-evals [#508](https://github.com/garrytan/gbrain-evals/pull/508) (merge commit `9af98d9d`), with its preregistration, counted data and paired analysis beside it.

## Decision and why

- **The automatic tier stays empty for people.** The preregistered bar was zero automatic errors with an upper bound of at most 1% for people; the measured rule reached 7.38% (upper bound 10.04%). People matches go to the proposed tier and are confirmed one entry at a time, showing what differs (employer, city, dates).
- **We plan a native version of the Splink-style method** for suggestions rather than add a dependency, and that plan doesn't approve automatic person links.

## Cost

The results page states the cost per correct decision for each model matcher but not the run's total paid cost; that sits in the run's ledger in gbrain-evals.

## What would reopen it

- Automatic person links: a rule or signal that can tell who owns a copied ID, measured at zero automatic errors with an upper bound of 1% or less on these case families.
- A model adjudicator: a matcher whose review-queue precision beats gbrain's by at least 5 points.
