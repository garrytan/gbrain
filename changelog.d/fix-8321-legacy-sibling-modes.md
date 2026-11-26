Fix strict Git publication failing with `git_unavailable` when a sibling of the written page has historical mode `100664` (#8321). Rebuilt trees canonicalize only that legacy non-executable mode to `100644`, preserving sibling blobs, raw names, untouched subtrees and unrelated staged changes. Strict tree validation remains enabled. Covers edit/add/remove on SHA-1 and SHA-256 repositories, branch retry, unknown-mode refusal and real managed publication on PGLite and PostgreSQL.

<!-- behavior-change: git_legacy_sibling_modes_8321 -->
