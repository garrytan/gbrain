---
kind: fix
---
A page the owner purged while a derived page kept it private now gets its purge records whichever later run removes it (an automatic expiry purge, or a run after a failed or deferred one), on repo brains and on brains without a repository, so a restore no longer brings it back. Restoring a backup now removes the same rows a live page purge removes (write requests, files, derived generation items and their effects), not only the page itself, and stops with purge_replay_incomplete, naming the purge it could not replay, instead of reporting success on a partial sweep. A new doctor warning, purge_mirror, says when recent purges are missing from this machine's purge mirror, so restoring an older backup would not replay them (#9469).
