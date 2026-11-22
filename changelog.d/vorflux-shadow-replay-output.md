**Shadow replay now compares what you would see (CLI JSON, CLI text and markdown, MCP output) and turns differences into test cases made of invented data.**

### Added
- `gbrain engine shadow replay` replays recorded CLI and MCP operations as operations and compares every surface they print on PGLite, Rust and optional local Postgres copies.
- For up to five differences per night it writes a synthetic test case: every word, slug, key, id, number and embedding is replaced, the case must still differ on fresh brains, and a leak check refuses any case that keeps input data. Saved cases under `test/fixtures/shadow-replay/` run in the test suite.
