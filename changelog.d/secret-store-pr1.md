**Secrets that gbrain redacts are now kept in an encrypted secret store, so you can read an original back or undo a false positive.**

<!-- behavior-change: secret_store_gst2988 -->

### Added
- `gbrain repair secret-spans --apply` seals each redacted value in an encrypted secret store (two new tables, migration v323) and writes a marker that names its entry, `<REDACTED:rule:ss_…>`. Retained versions of the page are redacted too.
- `gbrain secrets list`, `reveal`, `restore` (preview, then `--expect`) and `key status|export|import`. The key is a 0600 file on the machine that is never overwritten; `GBRAIN_SECRET_STORE_KEY` overrides it, and `key export` writes a passphrase-protected backup.
- MCP `reveal_secret`, granted only by name per token (`gbrain auth rescope --refresh-operations --add reveal_secret`; `--all-new` never adds it), only for pages the caller can read, and audited.
