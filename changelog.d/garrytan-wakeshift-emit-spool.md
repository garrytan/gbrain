**On a PGLite brain held by `gbrain serve` or the job worker, `gbrain wakeshift emit cron.finished` now records the run instead of dropping it, and revoking a credential always ends its watches.**

### Fixed

- A cron run that finished while `gbrain serve` or `gbrain jobs work` held the PGLite brain was lost. Emit now saves it as a small private file (0600) under the brain's own gbrain home, and the process holding the brain records it within seconds with its original finish time, so a watcher still wakes. Two processes reading the folder at once never record a run twice. A file that is malformed, oversized or has an impossible time goes to `rejected/` with one stderr line and never holds back the runs after it. At most 1,000 runs wait per brain. Postgres brains and brains with reporting back off never use the folder.
- The next direct `emit` also records any leftover runs, and it records its own run even when the leftovers can't be read.
- `gbrain auth revoke --id <id>` with a legacy token id written in uppercase now ends that token's watches and asks Wakeshift to forget its user.
- When removing an access member failed to ask Wakeshift to forget that member's user, the wake drainer now asks again. A member who is still active keeps their Wakeshift user.
