**Questions about the past now see earlier values in the facts block, with when each was told.**

<!-- behavior-change: facts_block_history_gbra574 -->
<!-- behavior-change: facts_block_told_after_gbra574 -->
<!-- behavior-change: facts_block_contested_gbra574 -->

### Added
- On a history cue (a history word, or a date that has passed), the query facts block also takes the named entity's ended facts (superseded, or past their `valid_until`), each with its own validity window. Forgotten and withdrawn facts, and facts from a deleted and purged page, never appear, and the caller's read policy applies as before.
- When a question names one date, each fact header in the block says `; told after DATE` for a fact said after it and `; learn date unknown` when the saying date is unknown.

### Fixed
- The facts block shows recall's contested label: `(contested by #ID)` on a fact in a pending supersede proposal whose other fact the caller can read; a failed lookup reports `contested_unavailable`.
