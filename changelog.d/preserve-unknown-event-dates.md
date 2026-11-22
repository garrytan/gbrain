**Preserve unknown event dates across PostgreSQL, PGLite and Rust.**

### Fixed

- Keep observation and recording times separate from the event date when writing or reconciling facts.
- Preserve undated facts in canonical Markdown, apply event-date filters to dated facts, and keep stored fact dates through schema and Rust store upgrades.

<!-- behavior-change: unknown_fact_event_dates_7247 -->
