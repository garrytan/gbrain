**Keyword search on the Rust engine now returns later pages too: asking for results past three times the page size no longer comes back empty.**

### Fixed
- On the Rust engine, `searchKeyword` with an offset at or past three times the limit (for example limit 1, offset 4) returned no rows, because it kept only `limit x 3` candidates before skipping the offset. It now keeps `(offset + limit) x 3`, capped at three times the search limit cap, the same window PGLite and Postgres use since #9922.
