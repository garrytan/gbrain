# Reading several pages in one call (closed, 2026-11-19)

- **We learned that letting agents read many pages in one call makes them read more pages, so total tool text goes up.** You should not expect a batch read to cut tokens unless the agent's reading policy changes too.
- **We learned that a batch needs a fair split of its budget.** Without one, a single long page pushed the rest out, and the agent re-read them one at a time.
- The pull request was closed unmerged.

## Question

Can `get_page` with a `slugs` list (up to 50 pages in one call, lean entries, a 12,000-token limit) cut the tool text agents spend reading pages, without losing answers or privacy?

## What was tried

- The feature was built in gbrain [#9798](https://github.com/garrytan/gbrain/pull/9798).
- **First dev loop.** 48 paired cells in gbrain-evals. Bars set in advance: the new option is used, answers stay within the margin, privacy holds, and tool text per cell goes down.
- **Fair-share fix (the "D1" pilot).** The batch now splits its budget fairly; a long page comes back cut to its share with its outline and a call to read on. A keyless pilot on 15 replay items checked it before any paid run.
- **Paid re-run** against a restated bar: page-read output at least 15% smaller, and total tool text no larger.

## Results

Reported by the build thread and the gbrain-evals team; not re-derived here.

| Run | Result |
|---|---|
| First dev loop | `slugs` used in 79.2% of cells (met). Answers 39.6% → 37.5%, within the margin. 0 privacy violations in 8,874 cells. Tool text per cell **+13.8%** (missed). |
| Why it missed | `get_page` is only 4.8% of tool text on the release, and one long page used the whole batch budget, so the others were omitted and re-read singly. |
| Fair-share keyless pilot (15 items, no model calls) | Page-read output 8.9% lower than the first build under the observed re-read behaviour, or 8.4% higher if every cut page is re-read whole. |
| Paid re-run | Page-read text **+18.6%** and total tool text **+3.4%**: agents read more pages per cell. |

Sources: [#9798](https://github.com/garrytan/gbrain/pull/9798) (closed) and internal reports (refs GST-3137, GBRA-650, GBEV-108, GBEV-110).

## Decision and why

Closed unmerged, as the maintainer ruled before the re-run: the fair-share fix gets one paid re-run, and a miss closes it. The follow-on search-row trim did not go ahead. One side change landed on its own: starter MCP clients can pass `valid_from` to `remember` ([#9802](https://github.com/garrytan/gbrain/pull/9802)).

## Cost

About $46 of model use for the build thread (plan, both builds, a side PR and probes). The fair-share pilot cost $0 in model calls. Eval spend sits on the gbrain-evals ledger and isn't included.

## What would reopen it

- Evidence that page reads are a large share of agent tool text on some workload (here they were 4.8%).
- A reading policy that stops agents opening more pages once a batch is cheap.
