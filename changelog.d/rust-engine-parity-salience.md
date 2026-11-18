**`gbrain salience` now lists pages with the same score in a fixed order: by source, then by slug.**

### Fixed
- When two pages had the same salience score, the order of those pages depended on where the database stored their rows, so it could change after an edit. Tied pages now sort by source, then by slug, on PGLite and Postgres.
