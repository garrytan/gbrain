---
kind: default
---
On a personal brain whose default source is a Git checkout, iMessage chat-day pages are now also files under .gbrain-owned/<source-id>/ in that checkout: each sync that changed something makes one commit, and the files are pushed like your other pages (a one-time code in a message is redacted at push time by default). Pages imported earlier stay in the database until their day changes or you run gbrain sync --source <id> --full. Shared, managed and repo-less brains, and checkouts that push to a repository gbrain cannot prove private, keep the pages in the database only. gbrain sources status <id> shows where they are; gbrain sources remove <id> takes the files out in one commit, and the remote's history still holds what was pushed.
