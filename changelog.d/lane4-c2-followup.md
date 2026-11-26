**Standing-rule corrections finish after an interrupted approval, never race a retirement, and `gbrain rules check` refuses a rule id it does not know.**

### Fixed
- When you approve a correction and a write is still being saved, your approval is kept and the next read of the receipt finishes it and confirms the rule, instead of waiting for you to approve again. The approval lives in a reserved config key only `gbrain rules approve` writes, so an agent that edits a receipt cannot approve its own rule.
- A correction resumed under a different connection (an owner's remote session, then your approval at the terminal) finds the fact change it already made instead of failing or changing the fact twice.
- Two calls retrying the same correction at once no longer delete its receipt, and a rule retired outside `gbrain rules retire` has its waiting correction settled by the next retire.
- A retirement started while an approval runs now waits for it, so a retired rule's fact is never changed afterwards and the receipt always says what happened (`rule_busy` after 15 seconds).
- A correction's first write never replaces a rule page that another call wrote first, even when it appears a moment before the write (`rule_exists`).
- A retried withdrawal reports `already_withdrawn` when another write withdrew the fact first, instead of claiming the change.
- A correction whose `entity` is a rule page in any spelling, or not the page the fact is on, is refused before anything is written; a remote caller that cannot read the fact gets `fact_not_found` instead of learning its page; and the approve prompt names the entity the rule corrects.
- `gbrain rules approve` exits 10 while a write is still being saved and 1 when nothing was approved, instead of 0. Approving an already active rule also marks its correction confirmed.
- `gbrain rules check <id>` fails on an unknown id and exits non-zero for a rule it cannot check yet; doctor's `rules_regression` checks every source and notes pages under `rules/` or of `type: rule` that remote writers can no longer change.

### Changed
- One connection can have at most 20 corrections waiting for the owner or unfinished (`correct_proposals_capped`), counted under a lock so calls sent together cannot pass it.
