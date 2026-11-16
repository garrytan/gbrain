---
kind: fix
---
gbrain sources git-reconcile now reports a source whose commit-push stopped with git_command_stopped because a git command ran past its time limit or was killed from outside as failed and retryable, exit 4, instead of needs_user, exit 1. A script that retries on exit 4 now retries it. A git command stopped by its output limit, or one that crashed (SIGSEGV, SIGBUS, SIGILL, SIGFPE or SIGABRT), still reports needs_user, exit 1, because a retry stops the same way.
