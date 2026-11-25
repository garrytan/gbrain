**A member with the labelled-only grant can no longer rewrite a page it is not named on, on a Rust brain, and it gets the same answer as on PGLite and Postgres.**

### Fixed
- On a Rust brain, the check that opens every remote page write did not look at the labelled-only grant, so a member holding it could rewrite an open page that does not name it. The check now reads the grant, and the rewrite is refused with `page_not_found` and nothing is written, exactly as on PGLite and Postgres. A rewrite of a page that names the member (or a group it is in) or that a folder rule the member satisfies covers is written; a page that names only other members, a malformed `readable_by`, an unsatisfied or removed folder rule, or a pending prefix stays refused. The Rust store now judges the writer's folder rules and the labelled-only grant itself.
- On a Rust brain, the owner and ordinary members could not rewrite an open page while any labelled-only member existed (also after it was disabled or removed): the write check read the owner id through a raw statement the Rust engine refuses. It now uses the typed config read the same file already used.
- An ordinary member whose folder rule covers a page can rewrite it on a Rust brain, as on PGLite and Postgres (it was refused with `engine_capability_missing`).

### Known gap
- On a Rust brain, a labelled-only member's create or capture of a new page is still refused with `engine_capability_missing` (PGLite and Postgres write a page that names the member, and refuse one that does not with `access_labelled_only_unnamed`). Nothing is written. Tracked as row 32e-b-3 in the Rust engine design doc.
