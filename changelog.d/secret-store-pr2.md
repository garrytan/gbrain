**A push no longer stops on a secret in commits that were never pushed: gbrain replaces the value with a secret store marker and pushes.**

<!-- behavior-change: publish_redacts_secrets_gst2988 -->

### Changed
- Every publish (`gbrain git commit-push`, a managed worktree's page-write backups, `gbrain sources refresh` and the other automatic pushes) rebuilds unpushed commits that hold a value the scanner names, with `<REDACTED:rule:ss_…>` markers, and pushes them. The originals go to the secret store (through an encrypted spool on the machine when the database is not at hand), the database copy of each redacted page gets the same marker, and the old commits stay under `refs/gbrain/backup/` for 7 days. `gbrain config set secrets.on_push refuse` keeps the old refusal, and so does `GBRAIN_SECRETS_ON_PUSH=refuse` (its only value; any other value changes nothing and prints a notice).
- A managed worktree's page-write backup that runs past its budget redacting or scanning is retried once in the background with 4 times the budget, without holding other checkouts.
- Files the scan cannot vouch for and changes to `.gbrain-scan-allow` or `.gitattributes` are held back in one local commit instead of blocking the push; the push is scanned with the remote's allowlist.

### Added
- `gbrain git redact-unpushed --source <id>`: preview what a publish would redact, then `--apply --expect <hash>`.
- `gbrain secrets list` shows how many redacted originals still wait in this machine's spool (`spooled` with `--json`).
- Notices `publish_secret_redacted`, `publish_secret_held_back`, `publish_secret_side_refs`, `publish_secret_unsigned`, `secret_store_spooled`; codes `publish_secret_rebuild_race`, `publish_secret_rebuild_unbounded`.
