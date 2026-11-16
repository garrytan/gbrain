---
kind: fix
---
gbrain git commit-push now refuses, before staging anything, when a file you name still has unresolved merge conflicts in the index, for example after a merge, rebase or stash pop that stopped on a conflict. It used to stage the file and commit it with its conflict markers as if it were resolved, and on an ordinary checkout push it. The refusal is commit_paths_unmerged (exit 1): nothing is staged or committed, the file stays unmerged, and the message names each file. Resolve each one (edit out the markers, or keep one side with git checkout --ours or --theirs -- <file>), mark it resolved with git add -- <file>, then rerun the commit. The same check covers every gbrain write that commits named files, such as lint --fix and connector writes.
