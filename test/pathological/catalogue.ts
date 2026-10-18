/**
 * The pathological catalogue (GBRA-130): for every per-item site in
 * src/core/item-failure.ts ISOLATE_SITES, the test file and the titles of its
 * item case (the bad item is held and the unit continues) and its run case (a
 * run-scoped failure at the same site still stops the unit and holds nothing).
 * The `Record<IsolateSite, …>` type makes a site without cases a compile error;
 * ./sites.test.ts checks that each named file holds each named title.
 */
import type { IsolateSite } from '../../src/core/item-failure.ts';

export interface SiteCases {
  /** Repo-relative test file. */
  file: string;
  /** Title (substring) of the case where one bad item is held and the rest continue. */
  item: string;
  /** Title (substring) of the case where a run-scoped failure stops the unit. */
  run: string;
}

export const CATALOGUE: Record<IsolateSite, SiteCases> = {
  'autopilot.global_maintenance': {
    file: 'test/pathological/a10-global-maintenance-stamp.test.ts',
    item: 'a phase failing the same way in three passes stops withholding the stamp',
    run: 'a run-scoped failure at the phase loop stops the job and records no streak',
  },
  'synthesize.postprocess': {
    file: 'test/pathological/a4-synthesize-postprocess.test.ts',
    item: 'A-4 item: a carried output whose postprocess request ended revision_conflict',
    run: 'A-4 run: a run-scoped error while reading a carried output stops the pass',
  },
  'synthesize.triage_verdict_cache': {
    file: 'test/pathological/b6-triage-verdict-surrogate.test.ts',
    item: 'B-6 item: a verdict the database refuses is not cached',
    run: 'B-6 run: a run-scoped error writing a verdict stops the pass',
  },
  'backfill.rows': { file: 'test/pathological/a47-backfill-poison-row.test.ts',
    item: 'item: a row whose UPDATE violates a CHECK is skipped, recorded and passed; its siblings land',
    run: 'run: a run-scoped failure (' },
  'purge.recorded_tombstones': { file: 'test/pathological/a49-unmanaged-purge-tombstones.test.ts',
    item: 'item: a tombstone whose delete is refused is reported and kept; the other tombstones and the bulk delete still purge',
    run: 'run: a run-scoped failure (' },
  'retention.expired_sources': { file: 'test/pathological/a50-unmanaged-expired-sources.test.ts',
    item: 'item: a source whose delete times out is blocked with its code and the manual purge; the other expired sources purge',
    run: 'run: a run-scoped failure (' },
  'consolidate.buckets': { file: 'test/pathological/a22-consolidate-buckets.test.ts',
    item: 'a private entity page with world facts fails its bucket and later buckets still consolidate',
    run: 'a run-scoped error inside a bucket still stops consolidate' },
  'extract_facts.expire_deleted': { file: 'test/pathological/a21-facts-expire-deleted.test.ts',
    item: 'a refused deleted-page expiry is reported and the other pages still expire and reconcile',
    run: 'a run-scoped error during a deleted-page expiry still stops extract_facts' },
  'maintain.cycle_sources': { file: 'test/pathological/a41-maintain-sources.test.ts',
    item: 'a source whose cycle throws is blocked with its code and the next source still cycles',
    run: "a run-scoped error in one source's cycle still stops maintain" },
  'patterns.ground_pages': { file: 'test/pathological/a23-patterns-grounding.test.ts',
    item: 'a refused leftover pattern page is reported, the new page grounds and the watermark is stamped',
    run: 'a run-scoped error while grounding a page still fails the phase' },
  'patterns.ground_timeline_appends': { file: 'test/pathological/a23-patterns-grounding.test.ts',
    item: 'a refused timeline-append page is recorded and the other page still grounds',
    run: 'a run-scoped error while grounding timeline appends still stops grounding' },
  'links.extract_stale': { file: 'test/pathological/a1-links-extract.test.ts',
    item: 'A-1 item: a page whose derive throws is reported', run: 'A-1 run: a run-scoped error at one page stops the unit' },
  'repair.apply_items': { file: 'test/pathological/a9-repair-core.test.ts', item: 'item case: an item whose apply throws', run: 'run case: a run-scoped' },
  'repair.all_kinds': { file: 'test/pathological/a45-repair-all-kinds.test.ts', item: 'item case: a kind whose plan throws', run: 'run case: a run-scoped' },
  'repair.content_lane_kinds': { file: 'test/pathological/a46-content-lane-kinds.test.ts', item: 'item case: fences throwing is recorded', run: 'run case: a run-scoped' },
  'migration.credential_reseal': { file: 'test/pathological/a27-credential-reseal.test.ts', item: 'item case: the unbuildable page is held', run: 'run case: a run-scoped' },
  'transcripts.ingest_session': { file: 'test/pathological/a2-transcripts-ingest.test.ts',
    item: 'item: a session the coordinator refuses is reported with its code and the other sessions land',
    run: 'run: a run-scoped failure inside a session stops the ingest' },
  'google.contact': { file: 'test/pathological/a3-google-items.test.ts',
    item: 'a failing contact and a failing event are counted, then held',
    run: 'run: a run-scoped failure inside a contact stops the sweep and records no hold' },
  'google.calendar_event': { file: 'test/pathological/a3-google-items.test.ts',
    item: 'a failing contact and a failing event are counted, then held',
    run: 'run: a run-scoped failure inside an event stops the sweep and records no hold' },
  'migrate_engine.loop_rows': { file: 'test/pathological/a31-migrate-loop-rows.serial.test.ts',
    item: 'A-31 item: a refused open_loops row is printed with its id and code and blocks the switch', run: 'A-31 run: a run-scoped error' },
  'effects.derived_retry_budget': { file: 'test/pathological/a11-effect-retry-budget.test.ts',
    item: 'A-11 item: a links and a facts-backstop effect failing every attempt', run: 'A-11 run: a run-scoped failure (' },
  'sync.import_files': { file: 'test/pathological/a18-ledger-path-text.test.ts',
    item: 'A-18 item: billing/q3.md (mode 000) is PERMISSION_DENIED', run: 'A-18 run: a run-scoped' },
  'propose_takes.pages': { file: 'test/pathological/a25-propose-takes-poison-pages.test.ts',
    item: 'A-25 item: the 5 newest pages fail every run', run: 'A-25 run: a run-scoped' },
  'extract_facts.phantom_redirect': { file: 'test/pathological/a24-phantom-redirect-cursor.test.ts',
    item: 'A-24 item: a phantom whose redirect throws is reported with its code and fix', run: 'A-24 run: a run-scoped' },
};
