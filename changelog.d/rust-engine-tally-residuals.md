**`gbrain doctor` and `gbrain search modes` now read the synopsis tier setting on a Rust brain, and list synopsis sources in one order on every engine.**

### Fixed
- On a Rust brain, the synopsis tier's configuration read (used by `gbrain doctor` and `gbrain search modes`) no longer stops on the raw SQL refusal. It reports a page whose trusted frontmatter picks the per-chunk synopsis tier, as PGLite and Postgres do.
- On a Postgres database with a linguistic collation (for example en_US), the synopsis sources now list in byte order, as on PGLite: a hyphenated source id no longer sorts as if the hyphen were missing.
- A page's chunks read over several sources (`get_chunks` under a token that reads more than one source) now come back in one order on every engine: chunks at the same place in the document are ordered by source id in byte order. A Rust brain answers this read instead of refusing it.
- When 1000 or more pages wait for search indexing, the search notice that says how many of them could change the answer now counts the same pages on every engine (the oldest pages first). A Rust brain gives this count instead of stopping the search.
- On a Rust brain, a remote caller that saves a fact no longer stops on a refusal when the save looks for an older fact the new one replaces. The check leaves out a fact whose page the caller may not read, as PGLite and Postgres do.
- `gbrain sources set-cr-mode` now works on a Rust brain. It sets or clears a source's own contextual-retrieval mode, the source row reads the mode back, and a source set to `per_chunk_synopsis` counts in the synopsis tier, as on PGLite and Postgres. On every engine the command now checks the source and writes the mode in one step.
