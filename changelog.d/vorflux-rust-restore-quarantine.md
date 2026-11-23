**A Rust brain restore can now refuse to publish work that would run by surprise, and a restored brain gets a fresh brain id.**

### Added
- The Rust store has a restore safety check and a restore step for the backup commands to call. The check counts unfinished write requests, recovery records, live effects, purges the backup lacks and kinds of record it cannot classify, and refuses with a named reason (`restore_step_unsupported` through `gbrain backup restore`). The step turns archived automation off, detaches sources from the old machine's folders, cancels unfinished jobs, and revokes the local writers and OAuth clients the backup held, naming each one. Access tokens are not revoked yet; a backup that holds them is refused.
- A restored Rust brain gets a new brain id, so it is never the same brain as the one it was copied from. The old and the new id are in the restore report. If the process stops between the two writes that record the id, the next open repairs the file from the record.
- A restore refuses, and changes nothing, when it runs inside an open transaction, when rebasing page origins would put two live pages on one file, or when its settings list leaves out a setting the store holds. Windows and UNC page origins are kept unchanged and counted in the report; rebasing them is not done yet.

Postgres and PGLite brains are unchanged and keep `pg_dump` and the PGLite backup. Nothing to do on upgrade.
