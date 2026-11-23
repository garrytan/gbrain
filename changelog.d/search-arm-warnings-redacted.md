**Search warnings on the terminal no longer print raw database error text.**

### Fixed
- When a search arm fails (the keyword, title, embedding or vector part of `search` and `query`, or the image fallback), the one-time warning on stderr used to include the error's own message. A database driver's message can carry a connection string or password. The warning now names the arm and the failure class only (`timeout`, `provider_error` or `skipped_after_timeout`), the same as the supersession warning. Search results and the `_meta.degraded` markers are unchanged.
