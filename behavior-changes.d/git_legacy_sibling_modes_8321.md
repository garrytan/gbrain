---
kind: fix
---
Strict Git-backed sources can publish page edits, additions and removals when a rebuilt directory contains a historical 100664 regular-file entry. The new commit records those entries as the equivalent non-executable 100644, preserving their names and blob contents. Only trees already rebuilt for the write are normalized; untouched subtrees and existing history remain unchanged. Unrelated staged content stays staged, and other invalid modes still refuse publication.
