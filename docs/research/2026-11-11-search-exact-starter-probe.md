# Putting search_exact on the starter tool surface (no change, 2026-11-11)

- **We learned that giving agents an exhaustive lookup from turn one helps on list-or-count questions, but not cleanly.** Correct answers rose from 9 to 17 of 84, but the interval nearly touches zero and Opus's cost per episode more than doubled.
- **We learned that most failures on these tasks are turn-cap stops,** so the next lever is fewer calls per answer, not another tool.

## Question

On Cat 40 Hard, list-or-count tasks (H1) fail most of the time: each needs 17 to 50 gold pages inside a 16-turn cap. `search_exact` already returns every match but is not on the starter MCP surface, so agents find it only through `request_tools`, late. Would putting it in reach from turn one help enough to change the default tool surface?

## What was tried

A probe on the Cat 40 dev set, world M, 84 paired episodes, Claude Opus 5.5 and GPT-6.1 Sol, with and without `search_exact` on the starter surface. The bar set before it ran: a material move on H1 goes to the maintainer as a default change; anything less doesn't.

## Results

Reported by the gbrain-evals team; not re-derived here.

| Measure | Without | With |
|---|---|---|
| Correct, pooled | 9 of 84 | 17 of 84 (+9.5 points, 95% +1.2 to +19.0, McNemar p = 0.057) |
| Opus | 4 of 42 | 7 of 42 (+7.1, −4.8 to +19.0) |
| Sol | 5 of 42 | 10 of 42 (+11.9, +4.8 to +21.4) |
| Opus cost per episode | $1.45 | $3.37 |
| Sol cost per episode | $0.73 | $0.77 |

53 of the 67 remaining failures hit the 16-turn cap, and items needing 35 to 50 gold pages went from 0 to 1 of 42. One `search_exact` answer returned 564,000 characters.

Source: internal notes (refs GST-2358, GST-2011).

## Decision and why

No change to the default surface. The gain was borderline and doubled Opus's cost. Two smaller follow-ups were recorded instead: cap `search_exact`'s result size, and help agents get from hit lists to opened pages.

## Cost

The probe's paid spend sits on the gbrain-evals ledger and isn't stated in the sources we could open.

## What would reopen it

- A capped `search_exact` that keeps the gain without the cost, or a Cat 40 turn cap that lets these tasks finish. The later [retrieval playbooks](2026-11-20-retrieval-playbooks.md) test chased the same failures from the prompt side.
