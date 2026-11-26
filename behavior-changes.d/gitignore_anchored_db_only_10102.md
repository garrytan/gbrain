---
kind: fix
---
Sync now writes a single-folder storage.db_only entry to .gitignore anchored to the repository root (/decisions/ instead of decisions/), so it no longer ignores tracked folders of the same name deeper in the tree (docs/decisions/). A line an older gbrain wrote is left as it is; change it to the anchored form by hand and commit it if a nested folder of that name is tracked.
