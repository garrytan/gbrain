**Structural code search now keeps the same chunks, in the same order, every time and on every engine.**

### Changed
- `gbrain query --near-symbol` and the two-pass walk look up the chunks that define a symbol, at most 50 per lookup. When more than 50 chunks matched, Postgres and PGLite used to keep whichever 50 the query plan returned, and on PGLite that set could change between runs of the same search. The lookup now keeps the first 50 by source, page slug and chunk position, on Postgres, PGLite and Rust alike, so a search with many matches returns the same results each time. Searches with 50 or fewer matches return the same results as before.
- The chunks the walk adds to the results now keep the walk's order when their scores tie, on every engine. They used to come back in whatever order the database returned them. On a Rust brain, structural search no longer stops with a refusal when it loads the chunks it added.
