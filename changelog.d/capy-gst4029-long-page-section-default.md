**Search and query now widen a hit on a long page to its matching section by default, instead of returning only the matched passage.**

<!-- behavior-change: long_page_unit_section_default -->

### Changed
- `search.long_page_unit` now defaults to `section` (it was `off`). On a long non-conversation page (20,000 rendered characters or more, `search.long_page_min_chars`), `search` and `query` return the section around the ranked passage, as far as the existing budget and long-page limits allow, so the agent sees the clause that decides the answer rather than a fragment. Widened sections share the budget with conversation hits, so a result that holds both can carry less conversation text. Short pages, explicit `return_unit` or `token_budget` calls, recall, think and `assemble_evidence` are unchanged, and a brain that already set the key keeps its value. `gbrain config set search.long_page_unit off` restores the old behavior. Approved default flip, measured in gbrain-evals#653: +9.6 points with Claude Opus 5.5 and +10.0 with GPT-6.2 Sol on 120 long-document tasks, at a lower cost per correct answer.
