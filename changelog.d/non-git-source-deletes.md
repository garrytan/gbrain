### Fixed

- Reconcile removed canonical files when syncing registered non-Git sources on managed brains. Classic brains continue to keep absent-file pages. File-watcher unlink events wake the same guarded reconciliation instead of leaving stale pages searchable. Preserve Git sync behavior, managed database-only edits, source boundaries, and delete limits.

<!-- behavior-change: plain_directory_source_deletes -->
