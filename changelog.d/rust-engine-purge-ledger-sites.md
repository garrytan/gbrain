**On a Rust brain, `gbrain forget <id> --purge` now finishes on a source that records belief history, with the same receipt and the same redacted history as Postgres and PGLite.**

### Fixed
- On the Rust engine, a fact purge on a source with belief history now redacts the purged claim from the recorded history (values, quoting fields, live and saved-version carriers, hidden derived rows) instead of refusing before it writes.
- The page purge's belief history steps run on the Rust engine too. A page purge on a Rust brain still stops first at the request index check, which another change serves.
