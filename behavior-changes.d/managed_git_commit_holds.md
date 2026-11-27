---
kind: fix
---
gbrain sync status now shows managed Git commits that keep failing (git_commit_holds in --json): the failed git step, a reason code (never git's own error text), and whether the checkout has no Git identity, with the fix as Next; when this host owns that checkout, the fix asks the user for the commit identity (needs_human). A git step that times out during the push, after the local commit, is now recorded as git_push_unavailable (a push hold) instead of git_unavailable, and a retried removal whose upstream cannot be read stays a push hold instead of completing unpushed.
