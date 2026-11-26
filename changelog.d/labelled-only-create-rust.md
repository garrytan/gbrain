**A member with the labelled-only grant can create and capture pages on a Rust brain, and a write over a deleted page is refused the way it is on PGLite and Postgres.**

### Fixed
- On a Rust brain, a labelled-only member's create or capture of a new page was refused with `engine_capability_missing`. A page that names the member (or a group it is in), or that a folder or page rule listing the member covers, is now written; a page that names nobody is refused with `access_labelled_only_unnamed`, the same error body as on PGLite and Postgres, and nothing is written.
- On a Rust brain, an ordinary member's write over a page that has only a soft-deleted row, naming readers or under a folder rule, was refused with `engine_capability_missing`. It is now refused as an unseen page (`page_not_found`), as on PGLite and Postgres.
- Two raw statements of the remote write check became typed reads. On PGLite and Postgres the create check now reads the folder rules that cover the slug (`readSlugFolderRules`) and judges the overlap itself instead of asking the database to compute the overlap, with the same answers; the deleted-row check sends the same statement as before.
