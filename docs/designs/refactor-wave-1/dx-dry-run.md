# Refactor wave 1: timed contributor dry-run (plan O18)

Six fresh agent sessions, one per change kind, each on a fresh clone of `refactor/wave-1` at `fdfc7082b`,
were told to land one throwaway change using only `CONTRIBUTING.md` and the files it points to. Each stopped at a
green `bun run verify` plus the tests the recipe names (E2E skipped: no database needed for these changes). Nothing
was committed. Target: 30 minutes or less per change kind.

| Change kind | Throwaway change | Elapsed | Wrong turns | Minutes lost |
|---|---|---:|---|---:|
| Storage method | `countPagesBySourceType` on both engines | 2.2 | engine files at their size ceilings (row said "Registry: none"); worked example showed a stale executor idiom | ~1.2 |
| Schema migration | an index on `pages (updated_at DESC)` | 1.5 | none (no guard warned about a duplicate index) | 0 |
| Doctor check | `dryrun_page_count` | 4.3 | `run` must name a top-level function; `emits` AST walk needs direct `checks.push`; last check pinned by a golden test | ~1.5 |
| CLI-only command | `gbrain dryrun-hello` | 2.4 | `printHelp` line trips the `cli.ts` ceiling; `phase` / `thinClient` / `selfHelp` unexplained | ~1.5 |
| HTTP route | `GET /admin/api/dryrun-ping` | ~1 (clock drift) | smallest test was structural only; mount-time ctx fields undocumented | ~1.5 |
| Sync phase | `renamesApplied` in the sync summary | 4.0 | `SyncResult` in `sync.ts` at its ceiling; value flow to finalize/report undocumented | ~1 |

Every recipe was correct in direction and every change kind landed well under the 30-minute target. Elapsed times
are short because the agents started warm (dependencies installed, repository cloned) and are faster readers than
people; treat them as a relative signal, not a human TTHW.

## Fixes applied in the same PR

- `CONTRIBUTING.md` "Where does my change go?": a note that the façades sit at their `check:module-size` ceilings and
  a change that adds lines raises the ceiling in the same commit; every row now names a behavior test to add next to
  the guards; storage row names the sibling shape (`getAllSlugs`), the ceiling edit, the test filename and seeding
  helpers; migration row explains when `build:schema-migrations` is needed and to grep `schema.sql` for an existing
  index; doctor row states the `run` / `checks.push` AST rules and the pinned last check; CLI row explains `phase`,
  `thinClient` and `selfHelp`; HTTP row maps `/admin/api/*`, `/mcp` and OAuth to their modules and documents the
  mount-time ctx fields; sync row documents the value flow from `SyncRun` to `printSyncResult` and the test harness.
- Worked example step 3 uses `scopedRead(this.engineSqlOn(tx))`, the idiom every sibling read uses, and step 2 says
  to declare only the columns that need conversion.
- `scripts/check-module-size.sh` failure text is FAIL/Why/Fix/See and says which additions cannot move.
- Golden drift (as opposed to a missing golden) now prints FAIL/Why/Fix/See with the regenerate command.
- The doctor `emits` assertion prints FAIL/Why/Fix/See naming the AST rule.

## Deferred

- A data-driven `printHelp` command list and a `makeTestServeHttpCtx()` helper would remove two of the ceiling bumps
  and the ctx-stub step; both are small follow-ups, not blockers.
