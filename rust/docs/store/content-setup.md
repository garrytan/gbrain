# Content-root setup

Every `gbrain init` runs content-root setup (`setupSharedBrainContent`, `src/core/shared-skills/setup.ts`). A
database-only init (`gbrain init --pglite --db-only`, and `gbrain init --rust`, which is always database-only) asks
two questions before it records a database-only receipt. Both are typed members; the SQL for PGLite and Postgres is
in `src/core/engine-sql/content-setup.ts`.

| Member | Answer on this engine | PGLite / Postgres |
| --- | --- | --- |
| `readFreshContentDatabase()` | `info().created`: the store creates its brain when it opens one, so a database is new exactly when this open created it | no `pages`, `config` or `persistence_brain` table yet (`to_regclass`), read before `initSchema` |
| `readContentSetupSource(sourceId)` | `brain.readContentSetupSource(sourceId)`: `{ id, incarnation, local_path }` of the source record when it exists and is not archived, else null | `SELECT id,incarnation,local_path FROM sources WHERE id=$1 AND NOT archived` |

## Not served

A content root (`--content-root`, `--git`, or the default owned root of `init --pglite`) claims the root and turns
managed mode on. A managed brain's import, sources add and extract run raw SQL that the Rust store refuses, so
`gbrain init --rust` refuses `--content-root` and `--git` by name, and `activatePersistence` /
`activateSharedSkillPersistence` refuse on the Rust engine (`requireManagedActivation`, `engine_capability_missing`,
`raw_sql`) before they read or write anything.
