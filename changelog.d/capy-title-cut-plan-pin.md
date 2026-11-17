**A new Postgres test now fails if the local title search stops using the index for rare words or the cheap early stop for common ones.**

### Added
- A test against the real Postgres planner checks the candidates step of the local title search. A word on a few pages must read matches from the full-text index, and a word on nearly every page must walk the primary key and stop after the page cap. The test changes no behavior.
