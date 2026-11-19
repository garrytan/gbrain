**The Rust engine remembers which facts `gbrain facts relink` already tried, so a rerun does not pay again for the same fact.**

### Changed
- The Rust engine now keeps the relink attempt record: the last outcome for each fact, the model verdict memos and the paid re-extraction memo of each conversation page. `gbrain facts relink` and conversation relinking skip a fact a model already judged, the same as on Postgres.
- On the Rust engine, the `unlinked_facts` doctor check now counts the conversation rows that free relinking already tried and the ones a paid re-extraction already covered, and names the right fix for each page. Before, those counts stopped on a missing-capability refusal.
- On the Rust engine, `gbrain facts relink` can now publish the facts it placed and link conversation facts to their pages. Before, those writes ran raw SQL the Rust engine does not take.
- `gbrain facts relink --conversation` now picks the same pages on Postgres as on PGLite and the Rust engine when two pages have the same number of facts to link. Before, Postgres sorted those pages by the database's language rules, so a run with a page limit could take a different page.
