**A labelled-only member can put and read pages under `GBRAIN_ENFORCED_MEMBER` on a Rust-engine brain, with the same answers as PGLite and Postgres.**

### Fixed
- On a Rust-engine brain, a labelled-only member (`gbrain access member labelled-only <id> on`) used to stop with "does not support" before its put wrote anything. It now behaves as on PGLite and Postgres. The member may rewrite a page that names it (or a group it is in, or that a folder rule it satisfies covers), is refused with `enforced_member_refused` a rewrite of a page that does not name it, and a new page unless a folder rule that lists it covers the slug. A refused put writes nothing.

### Known gap
- A member whose read goes through lineage (`access.members_read_lineage`), an audience of several identities, or an owner record still stops on a Rust-engine brain with "does not support" before its put writes anything. Tracked as row ec05-1 in the Rust engine design doc.
