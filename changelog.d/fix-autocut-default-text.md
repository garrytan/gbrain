**The `query` tool's `autocut` description now says autocut is off by default, which is what every search mode does.**

### Fixed
- The `autocut` parameter on `query` told agents it was on by default and never empty. It has been off in every search mode (`conservative`, `balanced`, `tokenmax`) since the ranker wave, so an agent that left it unset already got the full top results. The description now says so: autocut is off unless you pass `autocut: true` or set `gbrain config set search.autocut true`, and turning it on trims the results at the steepest score drop, which can drop relevant results on questions with more than one part. Search behavior is unchanged; a new PGLite test pins that `query` without `autocut` returns the full reranked set in `balanced` and `tokenmax`.
