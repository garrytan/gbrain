**Standing-rule corrections finish after an interrupted approval, never race a retirement, and `gbrain rules check` refuses a rule id it does not know.**

### Fixed
- When you approve another member's correction and a write is still being saved, your approval is kept on the receipt and the next read of it finishes the correction, instead of waiting for you to approve again.
- A retirement started while an approval runs now waits for it, so a retired rule's fact is never changed afterwards and the receipt always says what happened (`rule_busy` after 15 seconds).
- A correction's first write never replaces a rule page that another call wrote first (`rule_exists`).
- A retried withdrawal reports `already_withdrawn` when another write withdrew the fact first, instead of claiming the change.
- A correction whose `entity` is a rule page, or not the page the fact is on, is refused before anything is written, and the approve prompt names the entity the rule corrects.
- `gbrain rules check <id>` fails on an unknown id and exits non-zero for a rule it cannot check yet; doctor's `rules_regression` checks every source and notes pages under `rules/` or of `type: rule` that remote writers can no longer change.

### Changed
- One connection can have at most 20 corrections waiting for the owner or unfinished (`correct_proposals_capped`).
