import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { expect as bunExpect } from 'bun:test';
import { migrations } from '../../src/commands/migrations/index.ts';
import { sharedContentMigration } from '../../src/commands/migrations/shared-content.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { parseFactsFence } from '../../src/core/facts-fence.ts';
import { indexCompletedEntries, statusForVersion } from '../../src/core/migration-ledger.ts';
import type { CompletedMigrationEntry } from '../../src/core/preferences.ts';
import { LEGACY_DB_ONLY_SLUG, LEGACY_FILE_SLUG } from './managed-legacy-fixture.ts';
import { managedChainFixture, type ChainRun } from './managed-migration-chain.ts';

function phaseDetail(ledger: CompletedMigrationEntry[], version: string, phase: string): string {
  const entry = ledger.filter(e => e.version === version).at(-1);
  return entry?.phases?.find(p => p.name === phase)?.detail ?? '';
}

async function brainState(engine: BrainEngine) {
  return {
    facts: await engine.executeRaw(`SELECT id, entity_slug, source_markdown_slug, row_num, fact, source, expired_at,
      embedding::text AS embedding FROM facts ORDER BY id`),
    takes: await engine.executeRaw(`SELECT p.slug, t.row_num, t.claim, t.active, t.superseded_by FROM takes t
      JOIN pages p ON p.id = t.page_id ORDER BY p.slug, t.row_num`),
    pages: await engine.executeRaw('SELECT slug, compiled_truth, content_hash FROM pages ORDER BY slug'),
  };
}

/**
 * CEO-E1 / Eng harness: the real runner walks every registered orchestrator
 * migration on a managed brain whose legacy content targets v0.13.1
 * (grandfather), v0.28.0 (takes backfill) and v0.32.2 (fact adoption).
 */
export async function runManagedMigrationChain(databaseUrl: string | undefined, expect: typeof bunExpect): Promise<void> {
  const fixture = await managedChainFixture(databaseUrl);
  const transcript = (run: ChainRun) => `exit=${run.exitCode}\n${run.stdout}\n${run.stderr}`;
  try {
    const first = await fixture.applyMigrations();
    expect(first.exitCode, transcript(first)).toBe(0);

    const ledger = fixture.ledger();
    const index = indexCompletedEntries(ledger);
    for (const migration of migrations) {
      const entries = ledger.filter(e => e.version === migration.version);
      expect(entries.map(e => e.status), `v${migration.version}\n${transcript(first)}`).toEqual(['complete']);
      expect(statusForVersion(migration.version, index)).toBe('complete');
      // Host-agent TODOs by design: v0.14.0 always files its skill note, and
      // shared-content leaves host publication and client activation.
      if (entries[0].apply_migrations_pending) expect(['0.14.0', sharedContentMigration.version]).toContain(migration.version);
    }
    expect(JSON.stringify(ledger)).not.toContain('writer_coordinator_required');

    expect(phaseDetail(ledger, '0.13.1', 'grandfather')).toBe('touched=2 skipped=0 failed=0');
    expect(phaseDetail(ledger, '0.28.0', 'backfill')).toBe('extract-takes scanned 2 pages; 1 had fenced takes; upserted 2 rows');
    expect(phaseDetail(ledger, '0.32.2', 'fence_facts')).toContain('scanned=3 fenced=3 pages=2');
    expect(phaseDetail(ledger, '0.32.2', 'verify')).toBe('pages_checked=2');

    let engine = await fixture.open();
    let settled: Awaited<ReturnType<typeof brainState>>;
    try {
      settled = await brainState(engine);
      expect(settled.takes.map(t => [t.slug, t.row_num, t.active])).toEqual([[LEGACY_FILE_SLUG, 1, true], [LEGACY_FILE_SLUG, 2, true]]);
      const byId = new Map(settled.facts.map(f => [Number(f.id), f]));
      const { seed } = fixture;
      expect([...seed.legacyFactIds, ...seed.dbOnlyFactIds].map(id => [byId.get(id)?.source_markdown_slug, byId.get(id)?.row_num, byId.get(id)?.expired_at]))
        .toEqual([[LEGACY_FILE_SLUG, 2, null], [LEGACY_FILE_SLUG, 3, null], [LEGACY_DB_ONLY_SLUG, 1, null]]);
      for (const id of [...seed.legacyFactIds, ...seed.dbOnlyFactIds]) expect(byId.get(id)?.embedding).toBeTruthy();
      expect(byId.get(seed.extractorFactId)).toMatchObject({ row_num: 1, expired_at: null });
      expect(settled.facts.length).toBe(seed.legacyFactIds.length + seed.dbOnlyFactIds.length + 1);
      const positions = settled.facts.filter(f => f.row_num !== null).map(f => `${f.source_markdown_slug}#${f.row_num}`);
      expect(new Set(positions).size).toBe(positions.length);

      const file = readFileSync(join(fixture.root, `${LEGACY_FILE_SLUG}.md`), 'utf8');
      expect(parseFactsFence(file).facts.map(f => f.rowNum)).toEqual([2, 3]);
      const dbOnly = settled.pages.find(p => p.slug === LEGACY_DB_ONLY_SLUG);
      expect(parseFactsFence(String(dbOnly?.compiled_truth)).facts.map(f => f.rowNum)).toEqual([1]);
      expect(existsSync(join(fixture.root, `${LEGACY_DB_ONLY_SLUG}.md`))).toBe(false);
    } finally { await engine.disconnect(); }

    const rerun = await fixture.applyMigrations();
    expect(rerun.exitCode, transcript(rerun)).toBe(0);
    expect(fixture.ledger().filter(e => e.status !== 'complete')).toEqual([]);
    engine = await fixture.open();
    try { expect(await brainState(engine)).toEqual(settled); }
    finally { await engine.disconnect(); }
  } finally {
    await fixture.close();
  }
}

/**
 * Eng capacity split: with the migration writer's permanent request IDs
 * exhausted, schema migrations still complete (they admit nothing), the
 * first admission-requiring backfill refuses up front with queue_capacity
 * and the filled capacity command before it mutates anything, and after the
 * limit is raised the same runner completes the chain.
 */
export async function runExhaustedCapacityChain(databaseUrl: string | undefined, expect: typeof bunExpect): Promise<void> {
  const key = 'persistence.limits.principal_lifetime_ids';
  const fixture = await managedChainFixture(databaseUrl, { config: { [key]: '0' } });
  const transcript = (run: ChainRun) => `exit=${run.exitCode}\n${run.stdout}\n${run.stderr}`;
  try {
    let engine = await fixture.open();
    const before = await brainState(engine);
    await engine.disconnect();

    const refused = await fixture.applyMigrations();
    expect(refused.exitCode, transcript(refused)).toBe(1);
    const ledger = fixture.ledger();
    expect(ledger.filter(e => e.status !== 'complete').map(e => e.version)).toEqual(['0.13.1']);
    const detail = phaseDetail(ledger, '0.13.1', 'grandfather');
    expect(detail).toStartWith('queue_capacity: Write capacity exhausted: principal permanent request IDs (0 used of 0).');
    expect(detail).toContain(`gbrain config set ${key} `);

    engine = await fixture.open();
    try {
      const { LATEST_VERSION } = await import('../../src/core/migrate.ts');
      expect(Number(await engine.getConfig('version'))).toBe(LATEST_VERSION);
      expect(await engine.executeRaw('SELECT id FROM persistence_requests')).toEqual([]);
      expect(await brainState(engine)).toEqual(before);
      await engine.setConfig(key, '250000');
    } finally { await engine.disconnect(); }

    const raised = await fixture.applyMigrations();
    expect(raised.exitCode, transcript(raised)).toBe(0);
    const after = fixture.ledger();
    for (const migration of migrations) expect(after.filter(e => e.version === migration.version).at(-1)?.status).toBe('complete');
    expect(phaseDetail(after, '0.32.2', 'fence_facts')).toContain('scanned=3 fenced=3 pages=2');
  } finally {
    await fixture.close();
  }
}
