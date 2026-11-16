---
kind: fix
---
gbrain sources git-reconcile now reports a source whose commit-push stopped with git_command_stopped (a git command cut off by its time limit, an output limit or a signal) as failed and retryable, exit 4, instead of needs_user, exit 1. A script that retries on exit 4 now retries it; nothing needs the user.
