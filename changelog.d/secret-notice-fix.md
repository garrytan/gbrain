**A publish that redacts secrets no longer reports a failure that did not happen, and the secret audit logs are private to their owner.**

### Fixed
- The `secret_store_spooled` notice is now an info notice. It says the originals were sealed in this machine's encrypted spool, which every redacting publish does, and that the next owner push or maintenance pass moves them into the secret store. It also says that `gbrain git commit-push` does not move them itself. It used to be a degraded notice saying the store could not be written, which was not true. `gbrain doctor`'s `secret_store` check still reports originals left in the spool.
- The `secrets` and `secret-spans` audit logs (`~/.gbrain/audit/`) are now created at mode 0600, and an existing file with looser permissions is tightened on its next write. Before, a publish created them with the process umask (usually 0644). They hold page slugs, field names, store entry ids and span offsets, never a value.

<!-- behavior-change: secret_store_spooled_info_gst2988 -->
