# auto_chronicle fix wave notes (`capy/fix-wave-chronicle`, v0.60.45.0, #5876)

One integrated PR. Two lanes were built in parallel on master v0.60.39.0
(`f4739fff`) and merged here, in order, on top of master v0.60.41.0:

- Lane 1, core (`capy/chronicle-lane-core`): the `chronicle_page_state` ledger
  and write-time decision, the global `chronicle` cycle phase, the per-page
  budget scope, judge failure classes, publication with snapshot re-validation,
  event privacy lineage and generation reconciliation.
- Lane 2, surfaces (`capy/chronicle-lane-surfaces`): config keys and
  validation, doctor and advisor, the reason table and receipt field, the
  upgrade notice and migration skill, the guide and docs, backfill CLI changes.

The architecture is the approved cycle phase plus durable ledger. There is no
effects-queue kind, no dispatcher and no legacy import hook; the old
`runChronicleBackstop` is deleted.

## Integration decisions

1. **One reason table.** `src/core/chronicle/reasons.ts` (`CHRONICLE_REASONS`,
   stored fix Actions, never a stored next command) is the only table.
   `chronicleReceipt` in `ledger.ts` delegates to `chronicleBackstopReceipt`.
   `contract.ts` lost its duplicate table, its `next_command`/`ask_user`
   strings and the config keys and defaults that `config.ts` owns. Added the
   Lane 1 code Lane 2 lacked: `already_extracted`. `auto_chronicle_off` has no
   fix (off by choice). An invalid `auto_chronicle` word now records
   `auto_chronicle_invalid` (which has a fix) instead of `auto_chronicle_off`.
   The phase's no-chat-provider result carries the table's fix Action instead
   of a hand-written command.
2. **Config.** Lane 2's bounded `chronicle/config.ts` (ranges enforced by
   `config set`, malformed rows listed in `invalid`), so runtime and doctor
   read the same values.
3. **Ledger stub removed.** `test/helpers/chronicle-ledger-stub.ts` is gone. The
   surface tests seed rows on the real migration through
   `test/helpers/chronicle-ledger-rows.ts`, which creates a real page per row so
   the ledger's foreign keys hold.
4. **Migration skill** renamed to `skills/migrations/v0.60.45.0.md`.
5. **KEY_FILES** chronicle entry merged from both lanes.
6. **Tests.** Lane 1's tests that stayed red until Lane 2 replaced the old
   no-effect check pass after the merge. `test/auto-chronicle-no-effect-5876.test.ts` is deleted;
   `test/auto-chronicle-surfaces-5876.test.ts` replaces it. The only remaining
   mention of the old file is the wave 8 notes, which record what wave 8 did.
7. **Agent-operator contract.** The agent-operator wave is not on master yet, so
   Lane 2's stand-ins stay (`ChronicleAction`, `ChronicleEffect`,
   `ChronicleActor` in `reasons.ts`; doctor `auto_chronicle`'s inline
   `readiness`/`ask_user` details). TODOS.md lists the swap.
8. **Migration number.** Lane 1's placeholder v198 collided with master's v198
   (`publication_failure_detail`); the ledger is migration v199.

## Measured run (C9/C15)

Fixture: 31 pages written through `put_page` on a managed PGLite brain with the
feature at its default (on), `chronicle.auto_settle_seconds 0`, the default chat
model `anthropic:claude-sonnet-4-6`, then the `chronicle` phase run until
nothing was pending. Pages:

- 24 eligible: 16 meetings (one `visibility: private`), 6 conversations, 2
  calendar invites under `calendar/` whose end time had passed.
- 6 controls that must never be judged: a note, a person page, a diary page, a
  `dream_generated` meeting, a meeting under 80 characters, a concept page.
- 1 calendar invite that ends 16 days in the future.

Each eligible page carries hand-written expected events (53 in total), each with
a date and a set of keywords. An extracted event matches an expected event when
its day equals the expected date and its summary contains one of the keywords;
matching is a maximum bipartite matching per page. Unmatched extracted events
were then reviewed by hand: dated after the run day is premature; a plan stated
as if it happened is false; a second event for an already matched occurrence is
a duplicate; a true event the labels did not list is supported.

| | Run 1 | Run 2 |
|---|---|---|
| Receipts | 24 `pending`, 1 `not_yet_happened`, 1 `dream_generated`, 1 `too_short`, 4 without the field | same |
| Judged calls | 24 (each eligible page once) | 24 |
| Controls or the future invite judged | 0 | 0 |
| Events written | 54 | 52 |
| Recall (matched / expected) | 46/53 = 86.8% | 45/53 = 84.9% |
| False | 2 | 2 |
| Premature | 2 | 2 |
| False + premature, share of judged pages | 4/24 = 16.7% | 4/24 = 16.7% |
| Duplicates | 1 | 1 |
| Supported but unlabeled | 3 | 2 |
| Recorded spend | $0.0684 | $0.0679 |
| Unpriced calls | 0 | 0 |
| Wall time (writes + 4 phase runs of at most 8 pages) | 57.3 s | 55.8 s |

By page class: meetings recall 34/39 in both runs with 2 premature events
(16 pages); conversations recall 10/12 and 9/12 with 2 false events (6 pages,
both from one chat about a launch plan); calendar invites 2/2 with none wrong.
Both events of the private meeting were stored `visibility: private`.

Gate: false + premature must stay at or under 20% of judged pages, and recall at
or above 60%. Both runs pass (16.7%, 85-87%), so the automatic path was not
narrowed. Counting the duplicate as well gives 5/24 = 20.8%. The four wrong
events come from two patterns, filed in TODOS.md: a future date mentioned in a
past meeting becomes an event, and a plan in a chat is written as if it
happened. Total provider spend for the measurement: $0.136.

`foresights eval chronicle` (deterministic, 6 tasks): 6/6 on master `101799f1f`
and 6/6 on this branch.

No live OFF-vs-ON quality comparison was run; the default is on by the
default-on rule, not by a measured lift.

## Gate

Recorded in the PR body with the final branch SHA.

## For the agent-operator wave

When the agent-operator wave lands on master:

- Replace `ChronicleAction`, `ChronicleEffect` and `ChronicleActor`
  (`src/core/chronicle/reasons.ts`) with `Action`, `Effect` and `Actor` from
  `src/core/agent-output.ts`; the field names already match.
- Doctor `auto_chronicle` (`src/commands/doctor/checks/auto-chronicle.ts`):
  move `readiness: 'disabled_by_choice'` and the `auto_chronicle_default_on`
  `ask_user` decision (keep: `foresights config set auto_chronicle true`; opt out:
  `foresights config set auto_chronicle false`) onto its readiness and decision
  helpers.
- Register `chronicle_skipped` in `src/core/error-registry.ts` `CODES` with
  `reasons` = the `CHRONICLE_REASONS` keys: `auto_chronicle_off`,
  `auto_chronicle_invalid`, `slug_bound_client`, `operation_bound_client`,
  `no_extract`, `history`, `not_yet_happened`, `too_short`, `dream_generated`,
  `no_write_decision`, `not_chronicle_shaped`, `already_extracted`,
  `superseded`, `daily_limit`, `judge_llm_unavailable`, `no_pricing`,
  `budget_exhausted`, `judge_chat_error`, `judge_truncated`,
  `judge_parse_failed`, `malformed_proposal`, `publish_error`,
  `judge_refused`, `page_missing`, `no_events`, `no_chat_provider`.
- If the post-upgrade notice and the advisor's `auto_chronicle_default_on`
  become notices, add `auto_chronicle_default_on` to `NOTICE_CODES`.
- Then run `bun run build:error-codes` and `bun run check:agent-contract`.
