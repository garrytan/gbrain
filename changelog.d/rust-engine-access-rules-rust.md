**On the Rust engine, the folder-rule store works: the rules, revisions and pending prefixes are kept, `gbrain access rule list`, `rule status`, `rule history`, `gbrain access apply` and `resume` run, and a member outside a rule reads none of the pages under it.**

<!-- behavior-change: access_rules_byte_order -->

### Fixed
- On a brain with the Rust engine, `gbrain access rule list`, `rule status`, `rule history`, `gbrain access apply` and `gbrain access resume` no longer stop on a raw SQL refusal. The Rust store keeps the rules, the revision log and the pending prefixes, stamps each page written under a rule, and hides the pages under a rule from every member the rule does not name, as PGLite does.
- On the Rust engine, reads by a member whose folder rules change the page policy (salience, anomalies, entity identities, `gbrain access who-can-read`) are answered instead of refused, and the hot-memory cache is dropped when a rule changes.
- On a Postgres brain whose database uses a non-C collation, the rule list, the pending prefixes and the pages the `gbrain access apply` preview lists now come in byte order, as on PGLite.
- Still refused on the Rust engine, before any write: `gbrain access rule add` (its preview and its write), `rule rm`, `rule revert` and `rule import`, because their preview reads the held facts a change would move and those reads are not served yet.
