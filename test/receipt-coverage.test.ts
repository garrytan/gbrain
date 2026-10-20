/**
 * Receipt coverage (wave 9 follow-ups, Decision 10): every coordinated write
 * site, each with the guarded tables it changes and whether its rows commit
 * with a receipt.
 *
 * Protects: on a managed brain, facts and takes change only inside the
 * coordinator's publication of an admitted request (a receipt in the same
 * transaction). Fails when a new `withCoordinatedWrite` site appears without
 * an entry here, when a listed site disappears or moves, or when an entry
 * writing facts or takes is not receipted (the one listed exception names
 * its TODO). The pages, timeline and alias writers are listed with their
 * TODO: they still commit as coordinated maintenance without a request.
 * Runtime enforcement lives in the managed-connector contract harness
 * (test/helpers/managed-connector-job-contract.ts); production fail-closed
 * enforcement is a TODO.
 */
import { expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

type GuardedTable = 'pages' | 'tags' | 'slug_aliases' | 'page_aliases' | 'facts' | 'takes' | 'timeline_entries' | 'sources';
type Coverage =
  /** Runs inside the coordinator's publication of an admitted request (or a topology receipt). */
  | { sites: number; receipted: string }
  /** Commits coordinated maintenance without a request; `todo` names the follow-up. */
  | { sites: number; tables: GuardedTable[]; todo: string }
  /** Changes no knowledge rows of a guarded table (unguarded tables, physical columns, the source freshness stamp). */
  | { sites: number; tables: GuardedTable[]; other: string };

const RECEIPT_COVERAGE: Record<string, Coverage> = {
  'src/core/persistence/coordinator.ts': { sites: 2, receipted: 'the publication of an admitted request: every maintenance intent (conversation facts, fence reconcile, deleted-page expiry, takes reextract, take reprojection) applies here; a writeback import\'s folded pass stamp (afterEffects, #6712 PR 4b) runs inside that same receipted publication' },
  'src/core/persistence/group-publish.ts': { sites: 1, receipted: 'the grouped publication of admitted requests; each member is the attributed actor' },
  'src/core/persistence/memory-mutations.ts': { sites: 1, receipted: 'forget/withdraw: admitWriteInTransaction admits the request in the same transaction' },
  'src/core/repair/segmented-mirror.ts': { sites: 1, receipted: 'repair segmented-mirror: admitWriteInTransaction admits each page\'s repair request and completeWrite records its terminal receipt in the same transaction' },
  'src/core/facts/purge.ts': { sites: 1, receipted: 'purge_fact: admitWriteInTransaction admits the request and completeWrite records its terminal receipt in the same transaction' },
  'src/core/shared-skills/publication.ts': { sites: 1, receipted: 'shared-skill revision pruning inside an admitted skill publication' },
  'src/core/persistence/source-lifecycle.ts': { sites: 1, receipted: 'source add/claim/remove under a persistence_topology_changes receipt' },
  'src/core/persistence/topology-recovery.ts': { sites: 1, receipted: 'topology recovery under its persistence_topology_changes receipt' },
  'src/core/page-state/materialize.ts': { sites: 1, tables: ['pages'], todo: 'TODO(receipts): derived page materialization should publish as a maintenance intent' },
  'src/core/timeline-extract.ts': { sites: 1, tables: ['timeline_entries'], todo: 'TODO(receipts): timeline retraction should publish like managed_maintenance_timeline_extract' },
  'src/commands/reindex-aliases.ts': { sites: 1, tables: ['page_aliases', 'slug_aliases'], todo: 'TODO(receipts): reindex --aliases should publish per page as a maintenance intent' },
  'src/core/repair/aliases.ts': { sites: 1, tables: ['page_aliases', 'slug_aliases'], todo: 'TODO(receipts): gbrain repair aliases (#6619) deletes alias rows whose target page no longer exists (no page, no content column) in withCoordinatedWrite as explicit-only maintenance without a request; publish each item as a maintenance intent' },
  'src/core/repair/timeline-comments.ts': { sites: 1, tables: ['timeline_entries'], todo: 'TODO(receipts): gbrain repair timeline-comments row cleanup should publish per page as a maintenance intent' },
  'src/core/mentions/pass.ts': { sites: 1, tables: ['page_aliases'], todo: 'TODO(receipts): derived alias rows should publish per page as a maintenance intent' },
  'src/core/bootstrap/verify.ts': { sites: 1, tables: ['facts'], todo: 'TODO(receipts): bootstrap verify deletes its own probe facts without a request; publish the cleanup as a maintenance intent' },
  'src/core/trust/held-removals.ts': { sites: 1, tables: ['takes', 'timeline_entries'], todo: 'TODO(receipts): the owner accept of a held take or timeline removal (W1 #6783 §12 (a)) re-projects that row in withCoordinatedWrite as maintenance without a request when the page no longer carries it as stored; publish the accept as an owner request (a fence-carried take already reruns as a receipted takes_remove)' },
  'src/core/trust/owner-actions.ts': { sites: 1, tables: ['facts'], todo: 'TODO(receipts): the owner release of a held fact inserts it in withCoordinatedWrite as maintenance without a request; publish the release as an owner request' },
  'src/core/trust/page-handlers.ts': { sites: 1, tables: ['pages', 'facts', 'takes', 'timeline_entries'], todo: 'TODO(receipts): owner tier decisions (confirm/lower) change only trust_tier/write_origin in withCoordinatedWrite as maintenance without a request; publish them as owner requests' },
  'src/core/trust/backfill.ts': { sites: 3, tables: ['pages', 'facts', 'takes', 'timeline_entries'], todo: 'TODO(receipts): gbrain trust backfill and claim-sources --relower (#6533) set legacy trust_tier/write_origin (no content column) as attributed coordinated maintenance without a request; publish each batch as a maintenance intent' },
  'src/core/repair/frontmatter-keys.ts': { sites: 1, tables: ['pages'], todo: 'TODO(receipts): gbrain repair frontmatter-keys (#6454) strips the four parser-reserved keys from pages.frontmatter (no content column) in withCoordinatedWrite batches as explicit-only maintenance without a request; publish each batch as a maintenance intent' },
  'src/core/cycle/concept-publication.ts': { sites: 1, tables: [], other: 'concept provenance links (links is not a guarded table)' },
  'src/core/persistence/links-maintenance.ts': { sites: 1, tables: [], other: 'derived links and the pages attendance-blocked stamp (a physical column the guard exempts)' },
  'src/core/persistence/database-write.ts': { sites: 1, tables: [], other: 'manual links and chronicle ontology observations (unguarded tables)' },
  'src/core/shared-skills/retention.ts': { sites: 1, tables: [], other: 'shared-skill revision retention (unguarded table)' },
  'src/core/persistence/connector-path.ts': { sites: 1, tables: ['sources'], other: 'clears an unbound connector source local_path (source registration, not knowledge)' },
  'src/core/persistence/connector-sync.ts': { sites: 1, tables: ['sources'], other: 'the connector lease freshness stamp on its own source row' },
  'src/core/persistence/sync-run.ts': { sites: 1, tables: ['sources'], other: 'the managed sync freshness heartbeat on its own source row' },
  'src/core/persistence/sync-pass-run.ts': { sites: 2, tables: ['sources'], other: 'the pass\'s up-to-date and no-checkpoint freshness stamps (#6712 PR 4b) on its own source row, with the pass row' },
  'src/core/page-body/ingest.ts': { sites: 1, tables: [], other: 'segmentWriteScope: staged segment texts and manifest rows of an unpublished generation, and segment GC sweeps (page_segment_texts and page_body_manifest are guarded but hold no live body until the publication flips the generation)' },
};

/** Facts/takes writers allowed without a receipt this wave, each with its TODO above. */
const RECEIPT_EXCEPTIONS = new Set(['src/core/bootstrap/verify.ts', 'src/core/trust/backfill.ts', 'src/core/trust/held-removals.ts', 'src/core/trust/owner-actions.ts', 'src/core/trust/page-handlers.ts']);

const ROOT = join(import.meta.dir, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
}

function callSites(): Map<string, number> {
  const sites = new Map<string, number>();
  for (const path of sourceFiles(join(ROOT, 'src'))) {
    const count = readFileSync(path, 'utf8').split('\n')
      .filter(line => /\b(withCoordinatedWrite|withDerivedFactsWrite)\(/.test(line) && !/export (async )?function /.test(line)).length;
    if (count) sites.set(relative(ROOT, path), count);
  }
  return sites;
}

test('every coordinated write site is listed with its receipt status', () => {
  const sites = callSites();
  const unlisted = [...sites.keys()].filter(file => !(file in RECEIPT_COVERAGE));
  expect(unlisted).toEqual([]);
  const moved = Object.entries(RECEIPT_COVERAGE).filter(([file, entry]) => sites.get(file) !== entry.sites).map(([file]) => file);
  expect(moved).toEqual([]);
});

test('facts and takes change only with a receipt; every other guarded writer names its TODO', () => {
  const unreceipted = Object.entries(RECEIPT_COVERAGE)
    .filter(([file, entry]) => !('receipted' in entry) && entry.tables.some(table => table === 'facts' || table === 'takes') && !RECEIPT_EXCEPTIONS.has(file))
    .map(([file]) => file);
  expect(unreceipted).toEqual([]);
  for (const [file, entry] of Object.entries(RECEIPT_COVERAGE)) {
    if ('todo' in entry) expect({ file, todo: entry.todo.startsWith('TODO(receipts): ') }).toEqual({ file, todo: true });
    if ('other' in entry) expect({ file, guardedKnowledge: entry.tables.filter(t => t !== 'sources') }).toEqual({ file, guardedKnowledge: [] });
  }
  for (const file of RECEIPT_EXCEPTIONS) expect('todo' in RECEIPT_COVERAGE[file]!).toBe(true);
});

test('the managed derived-facts write API is gone: no facts writer bypasses the coordinator', () => {
  expect([...callSites().keys()].filter(file => readFileSync(join(ROOT, file), 'utf8').includes('withDerivedFactsWrite('))).toEqual([]);
});
