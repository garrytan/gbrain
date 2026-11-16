---
kind: fix
---
gbrain git commit-push no longer fails on a large checkout with git_unavailable "git ls-files -v failed: exit -1". Its git calls were limited to 1 MiB of output, so naming a folder whose index listing passed that (a few thousand tracked files with long names, more on a checkout of hundreds of thousands) killed git; they now read git's whole output. A git command that is stopped before it finishes (its time limit, or a signal such as the out-of-memory killer) now reports git_command_stopped with its reason (timeout or signal) instead of git_unavailable, still exit 1, and gbrain never uses its partial output as the answer. A push, fetch or remote listing stopped after the local commit still reports push_unconfirmed (exit 4).
