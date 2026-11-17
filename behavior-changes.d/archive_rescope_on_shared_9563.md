---
kind: fix
---
Conversation archive pages written while a brain was personal are now kept to the owner as soon as a command makes the brain shared: gbrain access member add and member enable (before the new member is added, enabled or bound to a token, so its credentials never read those pages), gbrain config set brain.audience shared and gbrain access owner set. Each prints one line on stderr per archive source saying the pages are kept to the owner or why they still wait. If the re-scope fails, member add and member enable change nothing and exit non-zero. Before, every member could read those pages until the next archive run.
