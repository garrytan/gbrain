# Follow-up: carry a chronicle row that a paid judge may still report to (pages-03)

Status: not started. This brief records what the pages-03 follow-up PR left out and why.

## The problem

The one-time frontmatter re-read gives a page a new content hash without changing what it says. Chronicle ledger rows
(`chronicle_page_state`) are keyed by content hash, so the re-read moves each row to the new hash; the new hash then
needs no second judging and the row's spend and campaign stamp stay with the page.

A pending or failed row can still have a paid judge calling the model for it. The lease is 15 minutes, the executor has
no judge timeout, and `failExhaustedCampaignRows` fails a campaign row as exhausted while its last attempt may still run.
No lease is provably over. When the judge reports, `finish` writes its spend and outcome by content hash, so a row that
moved under it loses the spend, and a publication the move superseded can lose its events.

What ships now (the simple rule): the re-read moves only settled rows (`extracted`, `skipped`) and never a pending or
failed row. The old row keeps its spend and campaign stamp, the cycle marks it superseded, and the new hash is judged
once more, outside the campaign. A chronicle attempt owns only the event pages whose live content is exactly what it
proposed (`publish.ts` `writtenEvents`).

The cost of the simple rule: a page that was in flight or failed at the upgrade is judged once more. The follow-up
should remove that second call without bringing back any of the cases below.

## Required tests (the race cases)

Each case must have a test that fails without the fix, on PGLite and Postgres. `test/frontmatter-reread-chronicle.test.ts`
holds the current versions under the simple rule.

1. Bug A: an imported page edited in its body only (title kept) is not proven old; it is scanned and judged again.
2. Bug B: a judge whose lease ended just before the re-read keeps its spend in its campaign.
3. Bug C: a late judge never overwrites a newer decision for the page (for example a `--no-extract` skip).
4. Bug D: events a publication wrote before the re-read superseded it stay owned by the page, also when the re-read
   renamed the page.
5. Finding 1: the campaign's last attempt, failed as exhausted while its judge still runs, keeps its spend.
6. Finding 2: a judge that follows its row keeps its attempt fence (the `request_id` and `attempts` check in `finish`),
   so a stale outcome never lands.
7. Finding 3: an operator edit to an event made between the event write and a failed activation is never owned, and a
   later generation keeps the edit.
8. Residual case: a settled row whose earlier paid attempt outlived its lease, or that a write decision settled while a
   judge was running, can still lose that late judge's spend when the re-read moves it. Older releases moved these rows
   the same way; this PR only narrows the moves. The follow-up must close it or prove it cannot happen.

## The rejected design: carry and forwarding records

The first fix recorded each row the re-read could not move as a carry in `op_checkpoints` (`chronicle-carry`), moved it
when the claim or the cycle settled the carry, and kept a forwarding record so a late `finish` could find where its row
went. It was dropped for these reasons:

- Each fix added a new race. Two review rounds found four and then three CRITICAL findings, all in the carry path:
  spend lost when a sweep changed the row's state (finding 1), the attempt fence lost when a judge followed its row
  (finding 2), and operator edits adopted when a failed activation re-read live hashes (finding 3).
- It needed locking between `finish`, the settlement pass and the claim on Postgres, and PGLite could not show those
  races, so its tests proved less than they appeared to.
- It added about 200 lines of state (records, settlement, follow logic) to one-time upgrade code.

A follow-up should prefer a design with no forwarding state: for example, key the judge's report on the row's stable
identity (page, extractor version, attempt) instead of the content hash, or keep the old row and copy its settled
outcome to the new hash when it settles. Whatever it does, cases 1 to 8 are the acceptance tests.
