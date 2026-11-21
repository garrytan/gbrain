**Every write path now says who wrote the row it stores, so a page, fact, take or timeline entry no longer lands at the `unknown` trust tier because its writer stayed silent.**

### Fixed
- Re-imports, reindexing, quarantine and oversized-page backfills, atom and synthesis restores, soft deletes by schema-pack and cleanup repairs, the fact-forget note, and the repairs that move rows between twin pages no longer lower a page's or fact's tier: they author nothing, so the row keeps the tier it had.
- Pages written by the code and image file importers, the receipt writer, concept publication, `brainstorm` and the transcript importers are stored at the tier their channel grants (owner source, derived, or agent-written), and pages and rows from the GitHub, Google and API connectors are stored as `external_untrusted`.
- Timeline rows that restate a page, written by `extract` over the database, the stale-link repair and the sweep, carry the page's own tier through the derived-write gate.

### Added
- A test-only strict trigger function (`STRICT_STAMP_TIER_FUNCTION_FOR_TESTS`) that raises `undeclared_write_trust` where the real function would store `unknown`, and `test/write-trust-declared.test.ts`, which runs every mutating operation and the non-operation write paths under it and fails by name when a path stops declaring its writer. The migration function bodies are unchanged.
