---
kind: fix
---
The secret_store_spooled notice a publish prints when it redacts is now an info notice that says what happened: every publish seals the originals in this machine's encrypted spool first, and the next owner push or maintenance pass moves them into the store (gbrain git commit-push does not). It used to be a degraded notice that said the store could not be written, which was not true. The secrets and secret-spans audit logs under ~/.gbrain/audit are now written at mode 0600, and an older file with looser permissions is tightened on its next write.
