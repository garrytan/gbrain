---
kind: fix
---
gbrain sync status now shows managed Git commits that keep failing (git_commit_holds in --json): the failed git step, its first error line with secrets removed, and whether the checkout has no Git identity, with the fix as Next. A git step that times out during the push, after the local commit, is now recorded as git_push_unavailable (a push hold) instead of git_unavailable.
