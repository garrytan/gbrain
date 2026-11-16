**Saved facts in query results now say when they were said, collapse their copies, match on word stems, and end at the right date when replaced.**

<!-- behavior-change: fact_rows_observed_date_gbra574 -->
<!-- behavior-change: superseded_fact_valid_until_gbra574 -->

### Fixed
- The facts block, temporal fact reserve, facts arm and recall date headers print the observed date of the page each fact came from, read under the caller's page access; a failed read reports `fact_observed_date_unavailable` instead of a silent `observed unknown`.
- Copies of one claim take one row in the facts block (dated as first stated, `(stated N times, last DATE)`), so restated facts stop crowding out older values; facts that differ by one word keep their rows.
- Question ranking of saved facts matches on stems under the brain's full-text config (an exact word still ranks above a stem-only match) and ignores dates, years and auxiliary verbs, so an as-of question admits the facts it names and a fact sharing only a year with the question is not admitted.
- Every supersession writer ends the replaced fact by one rule. It ends on the newer fact's `valid_from` when it falls inside the older fact's window, else at the older fact's own earlier end or now. New writes only.
