---
important: security
---
**Renaming a page no longer changes the trust tier of the page or of the facts filed under it.**

### Fixed
- A slug move (a sync rename, a file or frontmatter repair, an import that moves a page) used to stamp the page and every fact filed under it with the tier of whoever ran the move. An owner-run rename could promote an agent-written page and its facts to operator-curated without anyone reading them, and a rename with no declared tier demoted them to unknown. The move now keeps each row's stored tier on both PGLite and Postgres; edits made after the move still stamp the writer's tier as before. Rows that past renames already re-stamped are not changed by upgrading.
