**`gbrain doctor` now names any purge or withdrawal guard on Postgres that still lacks its ledger check, and a migration run no longer hides a failed guard re-create.**

### Added
- New doctor check `guard_ledger_checks`. On Postgres it names each purge or withdrawal guard whose body is missing the check that refuses a write role row-level security keeps from the ledger, so that role could still store purged content again or save a withdrawn fact active. It names the role that owns each guard. When the role doctor connects as may re-create them, the fix is `gbrain apply-migrations --yes`. Otherwise it prints the SQL the owning role runs. On PGLite, which has no row-level security, it reports not applicable (GST-2885, follow-up to #7632 and #9517).

### Fixed
- Every migration run re-creates the guards its role owns. That step used to swallow every error. Now only a guard another role owns stays silent (SQLSTATE 42501). Any other failure is reported on stderr with a line pointing at `guard_ledger_checks`. A concurrent update of the same function is retried (GST-2885).

### Documentation
- docs/ENGINES.md ("Purge and withdrawal guards"): a bulk fact insert whose row matches a withdrawal needs an `UPDATE` policy on `facts` for the write role, beside its `SELECT` policy (GST-2885).

<!-- behavior-change: guard_ledger_checks_gst2885 -->
