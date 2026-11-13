### A keyless brain keeps itself tidy, and doctor says when upkeep last ran

**`gbrain maintain --unattended` runs the free upkeep a brain needs, and is safe to run from a scheduler.** It runs the same steps as `gbrain maintain --safe` (link and timeline extraction, stale-page checks, the free repair lanes) plus a new bookkeeping cleanup step. It never deletes a page and never starts a paid model call, with one exception you can switch off. On a brain with an embedding key, it embeds pages and facts that are missing embeddings, capped at $1 a day per brain (`maintenance.embed_daily_usd`, 0 turns it off). Two runs that overlap embed once, because the second skips that step. It works the same on a brain with no git repository and no API keys. A run that has nothing to do, or that finds the brain busy, degraded, behind on migrations or already looked after by `gbrain autopilot`, exits 0 and says why. A step that fails three runs in a row is retried once a week instead of every run, and doctor names it until the step succeeds or stops being part of upkeep.

- `gbrain maintain --status` shows when upkeep last ran, what each step did, what failed, and when the next run is due.
- A new doctor check, `unattended_maintenance`, reports the same thing. It warns when upkeep hasn't run for 48 hours or a step keeps failing, and its fix is `gbrain maintain --unattended`. A brain where `maintenance.auto` is `false`, or where autopilot runs upkeep, reads as ok.
- `gbrain maintain --purge` previews which soft-deleted pages are past their 72-hour window. `--yes --expect <hash>` purges exactly the previewed set, and refuses with `preview_changed` when the set moved since the preview. Upkeep never purges pages on its own.

### Smaller changes

- The old bookkeeping cleanup inside the cycle's `purge` phase is now its own phase, `bookkeeping_gc`, with the same retentions. It never touches a page, so upkeep can run it while `purge` stays manual. `purge`'s summary now counts only pages, sources and orphaned clone folders.
- `gbrain autopilot --install` on a PGLite brain or a brain with no repository now refuses with a structured error (`autopilot_pglite_daemon`, `autopilot_no_repo`) that points at `gbrain maintain --status`, instead of a plain message.
- doctor's `cycle_freshness` fix no longer asks for spend consent on a brain with no chat or embedding key, since nothing it runs there costs money.
- The cycle's skip message for a phase that needs a filesystem no longer claims the reason is a Postgres or remote engine.

### Itemized changes

- `src/core/maintenance/run.ts` (new): the `--safe` step list (moved from `src/commands/maintain.ts`, which re-exports it), `unattendedPlan`, and `runUnattendedMaintenance`. The run record is `maintenance.last_run` in the database config, so repo-less brains have one. Brain-wide steps run once per run, then one item per source.
- `src/core/maintenance/status.ts` (new): `readUpkeepStatus`, the one view behind `--status` and doctor.
- `src/commands/doctor/checks/unattended-maintenance.ts` (new): the `unattended_maintenance` check.
- `src/core/cycle/bookkeeping-gc.ts` (new) and `src/core/cycle/phase-table.ts`: `bookkeeping_gc`, and a `tier` (`free`, `paid`, `deletes`, `filesystem`) on every phase, which the upkeep step list is tested against.
- `src/core/cycle.ts`: `CycleOpts.stamp` (`full`, `source_only`, `none`) so a partial run can't claim a full cycle, and `deferFactEmbedding` so fact extraction stays free on a keyed brain.
- `src/commands/autopilot-refusals.ts` (new) and `src/core/error-registry.ts`: new codes `autopilot_no_repo`, `autopilot_pglite_daemon`, `cycle_already_running`, `engine_degraded`, `maintenance_disabled` and `maintenance_owned_by_autopilot`.
- Tests: `test/maintenance-unattended.test.ts` (PGLite and Postgres) and `test/e2e/maintain-unattended-keyless-pglite.test.ts`.

<!-- behavior-change: unattended_maintenance_doctor_gbra438 -->
<!-- behavior-change: bookkeeping_gc_phase_gbra438 -->
<!-- behavior-change: autopilot_refusals_structured_gbra438 -->
<!-- behavior-change: cycle_skip_text_gbra438 -->
<!-- behavior-change: cycle_freshness_keyless_consent_gbra438 -->
