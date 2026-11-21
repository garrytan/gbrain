**The Rust engine keeps access members and groups, and `gbrain access group list` and the member removal preview list in the same order on every engine.**

<!-- behavior-change: access_groups_pages_byte_order -->

### Fixed
- On a brain with the Rust engine, `gbrain access member add`, `disable`, `enable`, `set --email`, `kind` and `labelled-only`, and `gbrain access group add` and `rm`, write the same members and groups as PGLite instead of stopping on a raw SQL refusal. A stdio server bound to a member reads as that member, and the serves keys (`access.serves_derived`, `access.serves_since`) move as on PGLite.
- On the Rust engine, the reads that need a token's member binding refuse with a typed error instead of answering an empty list: `gbrain access member add --bind-token`, `gbrain auth rescope --member`, `gbrain access owner set` and `gbrain access member rm` stop before they write anything, and so does a page read by a labelled-only member.
- On a Postgres brain whose database uses a non-C collation, `gbrain access group list` (groups and their members) and the page list of `gbrain access member rm` and `group rm` previews now come in byte order, as on PGLite.
