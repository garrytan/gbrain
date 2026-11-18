**The secret store now backs itself up, encrypted, to your storage bucket, and `gbrain doctor` reports its health.**

### Added
- `gbrain secrets backup` uploads an encrypted export of the secret store to the storage backend you already configured for files (Supabase, S3 or local), and maintenance does it after new entries. The bucket gets no value, page name, path or rule in clear, and never the key; `gbrain secrets backup --restore <object>` adds back the entries a brain lacks, only where the key is. With no backend, the database backup carries the store and nothing is needed.
- `gbrain doctor` has a `secret_store` check: entries, the last backup, keys entries need that this host lacks (`secret_store_key_forked`), a key whose escrow copy was never exported, originals waiting in the spool, held-back publish commits and local refs that still hold commits from before a redaction rebuild.

### Known limits
- Purging a page does not yet remove its sealed originals from the secret store. They stay encrypted, and `gbrain doctor`'s `secret_store` check still counts them. Removing them with the page follows in a later release.
