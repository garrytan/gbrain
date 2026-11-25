---
kind: fix
---
The credential vault lock no longer proceeds without the lock after 5 seconds or takes over a lock just because it is 10 seconds old. A writer that cannot take the lock now fails with vault_lock_busy (retry), and only a lock whose process is gone, or one older than a minute, is taken over. Each Google account's grant now carries a generation bumped by every consent, reconnect and import; a token refresh writes only onto the generation it read, so a refresh that races a disconnect or reconnect is dropped (vault_generation_changed) instead of writing the old grant back. Refreshes of one grant are serialized across processes.
