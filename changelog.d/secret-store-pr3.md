**The secret store now backs itself up, encrypted, to your storage bucket, and `gbrain doctor` reports its health.**

### Added
- `gbrain secrets backup` uploads an encrypted export of the secret store to the storage backend you already configured for files (Supabase, S3 or local), and maintenance does it after new entries. The bucket gets no value, page name, path or rule in clear, and never the key; `gbrain secrets backup --restore <object>` adds back the entries a brain lacks, only where the key is. With no backend, the database backup carries the store and nothing is needed.
- Purging a page now removes the secret store originals only that page referenced, so `gbrain delete <slug> --purge` leaves no sealed copy of a secret the page held. An original another page or a redacted publish commit still points to stays.
- `gbrain doctor` has a `secret_store` check: entries, the last backup, keys entries need that this host lacks (`secret_store_key_forked`), a key whose escrow copy was never exported, originals waiting in the spool, sealed originals nothing references any more, held-back publish commits and local refs that still hold commits from before a redaction rebuild.
