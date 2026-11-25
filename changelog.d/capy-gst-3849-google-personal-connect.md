**Connect each Google account through its own one-click Personal-mode client, with read-only tokens only and a vault that never writes unlocked.**

### Added
- `gbrain google setup --personal --account <email>` prints Google's one-click Personal-mode link for that account and stores the resulting client with that account only (one client per mailbox).
- `gbrain google connect --import -` moves an already-consented grant onto this machine from stdin, after proving the account and checking the scopes are read-only.
- `gbrain sources set-access <id> vault` moves a Google source off the shared gbrain.io relay onto the account's own connection, keeping its id, private senders and ingest tiers; the next sync picks up from about a day before the newest imported message. It refuses (`scope_missing`) when the account's grant can't read a service the source syncs.
- `gbrain google status --account <email>`, showing only that account and its sources, with each account's client mode and grant generation.

### Changed
- Google consents ask for read-only scopes only and never merge earlier grants; a consent, import or refresh that returns a scope able to change data is refused (`write_scope_refused`) and nothing is stored.
- An OAuth client is saved only together with a finished, verified consent, so a failed consent or a wrong account keeps the previous connection intact.
- Refresh picks the client that minted each account's tokens and refuses a different one (`client_record_mismatch`).

### Fixed
- The vault lock fails closed (`vault_lock_busy`) instead of writing without the lock, and token writes are compare-and-swap on a grant generation, so a refresh racing a disconnect or reconnect can't write the old grant back. `gbrain creds import` gives each restored grant a fresh generation for the same reason, and a stale lock left by a dead process is taken over by one waiter at a time.
- A Google source moved from gbrain.io to the vault kept a window-mode cursor and imported nothing; it now anchors Gmail's change feed.
- `gbrain google status` reports a failed refresh probe as not ok (exit 1) and an unprobed account as `unprobed`.

<!-- behavior-change: google_consent_read_only_gst3849 -->
<!-- behavior-change: google_vault_lock_fail_closed_gst3849 -->
<!-- behavior-change: google_personal_mode_gst3849 -->
<!-- behavior-change: google_status_refresh_health_gst3849 -->
