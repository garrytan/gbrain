**Vector search no longer drops its results on large Postgres brains read under row-level security.**

### Fixed
- On Postgres, a reader limited by row-level security could lose the vector half of every search once it could see about 50,000 chunks: each pooled attempt sorted every visible chunk, ran past the 8-second vector budget and was dropped. Pooled attempts that follow the HNSW index now stay on it, a short iterative window goes straight to the exact fallback, and searches scoped to a source get their share from row counts when the reader cannot see planner statistics. (#10500, reported by @babyspectrum)
