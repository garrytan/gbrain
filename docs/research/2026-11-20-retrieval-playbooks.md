# Retrieval playbooks: a search recipe served on the turn (cut candidate, 2026-11-20)

- **We learned that a short search recipe changes how an agent searches, but not by enough to build.** Handed a three-to-five-line recipe for "list or count everything that matches" questions, agents used about a quarter less tool text and ran out of turns less often. They got 3 more of 14 questions right, one short of the bar set in advance.
- **We learned that gbrain's own served instructions decide an agent's first call.** The MCP server tells agents to call `context_pack` at session start ([src/mcp/instructions.ts](../../src/mcp/instructions.ts)). GPT-6.2 Sol made `context_pack` its first call in 14 of 14 recipe cells, whatever the recipe said. You should check the served instructions before designing any prompt-side fix.
- Nothing was built and nothing shipped.

## Question

Agents on Cat 40 Hard (a synthetic company in gbrain-evals) never fetched 435 pieces of evidence they needed, and 433 of those were in one question family: "list or count everything that matches". Would serving a matching search recipe on the turn, before the agent plans, recover those answers? The idea came from the "playbooks" feature of a commercial agent-context product: a stored procedure handed to the agent when a matching request arrives.

## What was tried

- **Plan.** A gstack /autoplan run (one reviewer, Claude Opus 5.5) and an approved plain-language plan: six built-in recipes, matched by words with no model call, served once per conversation through the per-turn "check gbrain first" hook. The plan required a cheap test before any build.
- **Quick look (E1).** Build v0.60.751.0. The same 14 list-or-count items on Cat 40 world M, Claude Opus 5.5 and GPT-6.2 Sol, plain against one frozen recipe (sha256 `320572723370b96c…`) put before the question, at Cat 40's 16-turn cap. Bars set in advance: the recipe arm gets at least 4 more items right than plain (bar 1), and the agent's next call follows the recipe's first step in at least half the cells, checked by tool name with no judge (bar 2).
- **One retest at a 32-turn cap.** E1's misses were mostly turn-cap stops, so one paired retest ran on the same items, models, build and recipe, with the same +4 bar and a $150 paid cap. The rule, written before the retest ran: a fail closes the plan as a cut candidate, with no further retest.

## Results

Reported by the gbrain-evals team; we could not open their run records, so these are their numbers, not re-derived.

| Run | Plain | Recipe | Bar 1 (+4 items) | Bar 2 (follows) |
|---|---|---|---|---|
| E1, 16-turn cap | 3 of 28 cells | 3 of 28 cells (same cells) | +0, fail | 14 of 28 cells, met (all Opus) |
| Retest, 32-turn cap | 6 of 14 items | 9 of 14 items | +3, fail by one | 28 of 28 cells, pass |

- In the retest, turn-cap stops fell from 10 to 7 of 28 cells, tool-result characters per cell fell 26% (664,761 to 489,543), and tool calls fell from 54.6 to 49.6 per cell.
- Never-returned gold rose from 6.86 to 9.25 per cell, driven by three early "UNKNOWN" answers in cells that plain also got wrong.
- With one run per question (k = 1), a difference of one item is within noise: same-build runs disagree on about 17% of rows.
- A side finding from the plan's review, read in the code and not run: `get_page` with `known_as_of` returns only world-visible history to an owner's own remote token, which is narrower than what the owner can read. It is tracked as its own bug.

Sources: the eval runner change was gbrain-evals [#550](https://github.com/garrytan/gbrain-evals/pull/550) (closed, not merged); plan, review record and results in internal reports (refs GST-3248, GBRA-669, GBEV-114).

## Decision and why

Cut candidate. The retest missed the preregistered bar by one item, and the rule written before it ran closes the plan on a fail. Nothing was built.

## Cost

About $16 of model use for planning, including a $2.76 reviewer. Paid eval spend, reported by the eval team: $71.21 for E1, plus up to $18 on a lost VM, and $104.90 for the retest.

## What would reopen it

- A Cat 40 run with a turn cap long enough that list-or-count tasks can finish, or more than one run per question, so a 3-to-4-item gain can be told from noise.
- Served instructions that no longer fix the first call, so a per-turn recipe can actually lead.
- A server-side alternative (one call that returns every matching record) is the other route to the same misses; see the [search_exact probe](2026-11-11-search-exact-starter-probe.md).
