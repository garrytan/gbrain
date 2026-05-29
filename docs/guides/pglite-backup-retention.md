# PGLite Backup Retention

GBrain keeps PGLite recovery directories during rebuilds and embedding-dimension
migrations. These dirs are rollback evidence, not active runtime state.

## Keep

- `brain.pglite` — active DB.
- One recent known-good `brain.pglite.bak*` backup while validating a rebuild.

## Short-Lived Evidence

Keep these only until the next scheduled Dream run succeeds and `gbrain doctor`
shows no PGLite lock or embedding-width failure:

- `brain.pglite.corrupt-*`
- `brain.pglite.bad-dim-*`

After that, archive or delete them. They are known-bad recovery evidence and can
mislead future debugging if left beside the active DB.

## Verification Gate

Before deleting backup dirs, run:

```bash
gbrain sources status
gbrain doctor --json
gbrain dream --dry-run --json --dir /path/to/brain --source <source-id>
```

Only clean up after those commands confirm the active DB is reachable, embedding
width matches config, and Dream can complete without lock timeouts.

`gbrain doctor` surfaces this as `pglite_backup_retention`. It never deletes
files for you.
