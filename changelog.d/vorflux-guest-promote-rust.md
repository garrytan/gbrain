**A Rust brain now handles guest notes after they are saved: the owner can keep one as an owner page, a remote writer can delete its own note, and a remote reader sees the guest warning, as on PGLite and Postgres.**

### Changed
- `gbrain guests promote` (and the `promote_guest_note` tool) works on a Rust brain. It writes the owner page and the link once; a second run answers `already_promoted`, and every read of the note then says it was promoted.
- A remote delete of a guest note on a Rust brain follows the same rules as PGLite and Postgres. A writer deletes only the notes it saved (`permission_denied` otherwise), and never a note the owner kept (`guest_page_promoted`).
- A remote reader that a guest note names reads it on a Rust brain with the same guest warning. A reader the note does not name gets `page_not_found`.
- A Rust brain stores the owner's promotions. A guest page deleted for good takes its promotions with it. A seed of a Rust brain from PGLite or Postgres copies them.
- Not reachable on a Rust brain: Postgres row-level security that hides the guest-source table from a database role. The Rust store has no database roles.
- Tests: `test/engine-parity/guest-promote.test.ts` checks promotion, remote deletes and remote reads on every engine arm.
