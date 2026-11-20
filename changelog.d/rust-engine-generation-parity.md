**The generation ledger reads answer in the same order on every engine, and Postgres, PGLite and a Rust brain agree on the same stored history.**

### Fixed
- The generation ledger reads behind `gbrain repair generations`, managed publications and fence publishes now return their rows in one fixed order, with text sorted by bytes. Before, PGLite returned some of them in storage order, and Postgres sorted source ids and keys by the database's language rules (so `a-z` and `ab` swapped places between engines).
- The purge scrub on a Rust brain now finds a purged number in stored generation history as Postgres prints it (`1.0`, `1.50`), and treats a stored JSON `null` as a value, as Postgres does. Before, it read `1.0` as `1` and could miss or over-count rows.
- `gbrain repair generations --since` takes an instant with a time zone (for example `2026-10-01T00:00:00Z`) on every engine. A bare date, a time with no zone or a word like `yesterday` now refuses with one clear message everywhere, instead of being read in the session time zone on Postgres and refused only on a Rust brain. The CLI already sends an instant, so CLI use does not change.
- Every engine now refuses a managed activation id that is not a UUID before it writes it. Before, one such row made the list of left-behind pages fail for every caller on Postgres.

### Changed
- A `gbrain repair generations` preview taken before this upgrade on a brain with several sources may refuse as changed after it. Take the preview again.
