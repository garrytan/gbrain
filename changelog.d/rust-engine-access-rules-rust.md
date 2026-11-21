**On the Rust engine, folder rules work: `gbrain access rule add` and `rm`, `gbrain access apply` and `gbrain access rule status` give the same results as PGLite, and a member outside a rule reads none of the pages under it.**

<!-- behavior-change: access_rules_byte_order -->

### Fixed
- On a brain with the Rust engine, `gbrain access rule add` (with its preview), `gbrain access rule rm`, `gbrain access apply` and `gbrain access rule list` and `status` no longer stop on a raw SQL refusal. The Rust store keeps the rules, the revision log and the pending prefixes, stamps each page written under a rule, and hides the pages under a rule from every member the rule does not name, as PGLite does.
- On the Rust engine, reads by a member whose folder rules change the page policy (salience, anomalies, entity identities, `gbrain access who-can-read`) are answered instead of refused, and the hot-memory cache is dropped when a rule changes.
- On a Postgres brain whose database uses a non-C collation, the rule list, the pending prefixes and the pages the `gbrain access apply` preview lists now come in byte order, as on PGLite.
- `gbrain access rule migrate` (moving a source's rules between the database and git) still stops on the Rust engine with a typed refusal before it writes anything.
