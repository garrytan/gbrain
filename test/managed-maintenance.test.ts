import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPhaseConsolidate } from '../src/core/cycle/phases/consolidate.ts';
import { runPhaseSynthesize } from '../src/core/cycle/synthesize.ts';
import { runPhasePatterns } from '../src/core/cycle/patterns.ts';
import { runCycle } from '../src/core/cycle.ts';
import { maintenancePreflight, publishMaintenancePage, prepareMaintenanceMutation } from '../src/core/persistence/prepared-maintenance.ts';
import { claimWorktree, getWorktreeBinding, acquireWorktree } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer, startPersistenceConsumer } from '../src/core/persistence/service.ts';
import { claimNextWrite, getWriteRequestById } from '../src/core/persistence/journal.ts';
import { publishMutation } from '../src/core/persistence/coordinator.ts';
import { localHostId, revokeLocalWriter } from '../src/core/persistence/identity.ts';
import { submitForgetMutation } from '../src/core/persistence/memory-mutations.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { readJournalLimits } from '../src/core/persistence/limits.ts';
import { parseMarkdown, serializePageToMarkdown } from '../src/core/markdown.ts';
import { configureGateway, resetGateway, __setChatTransportForTests } from '../src/core/ai/gateway.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { withSubmissionAuthority } from '../src/core/minions/submission-authority.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';

const engines: BrainEngine[] = [];
const dataDir = mkdtempSync(join(tmpdir(), 'gbrain-maintenance-db-'));
let closePostgres: (() => Promise<void>) | undefined;
beforeAll(async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
  const engine = new PGLiteEngine();
  await engine.connect({ database_path: dataDir }); await engine.initSchema(); engines.push(engine);
  if (process.env.DATABASE_URL) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.push(pg.engine); closePostgres = pg.close;
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.(); resetGateway(); rmSync(dataDir, { recursive: true, force: true });
});

async function fixture(run: (engine: BrainEngine, sourceId: string, root: string) => Promise<void>, owner = true) {
  for (const engine of engines) {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-maintenance-test-'));
    const root = join(dir, 'brain'); mkdirSync(root);
    const sourceId = `maintenance-${randomUUID().slice(0, 8)}`;
    try {
      await withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
        await engine.setConfig('sync.write_through', 'true');
        await engine.setConfig('dream.patterns.enabled', 'false');
        await engine.setConfig('dream.synthesize.enabled', 'false');
        await engine.setConfig('dream.synthesize.session_corpus_dir', root);
        if (owner) await claimWorktree(engine, sourceId, root);
        await run(engine, sourceId, root);
      });
    } finally {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

async function seed(engine: BrainEngine, sourceId: string, slug = 'people/example', visibility = 'world') {
  const ctx = { engine, sourceId, remote: false as const, config: { engine: engine.kind, embedding_disabled: true },
    dryRun: false, logger: { info() {}, warn() {}, error() {} } };
  await submitPageMutation(ctx, { operation: 'put_page', params: {
    slug, content: `---\ntitle: Example\ntype: note\n---\nExample evidence for ${slug}.`, request_id: randomUUID(),
  } });
  await seedFacts(engine, sourceId, slug, visibility);
}

async function seedFacts(engine: BrainEngine, sourceId: string, slug: string, visibility = 'world') {
  const vector = `[${[1, ...Array(1535).fill(0)].join(',')}]`;
  for (let i = 0; i < 3; i++) {
    await engine.executeRaw(`INSERT INTO facts(source_id,entity_slug,fact,kind,source,visibility,confidence,valid_from,embedding)
      VALUES($1,$2,$3,'fact','test',$4,$5,$6::timestamptz,$7::vector)`,
    [sourceId, slug, `Example claim ${i}`, visibility, 0.9 - i / 10, `2026-01-0${i + 1}T00:00:00Z`, vector]);
  }
}

test('runCycle consolidates only its explicitly selected source across two eligible source clusters', async () => {
  await fixture(async (engine, sourceId, root) => {
    const otherSourceId = `other-${sourceId}`;
    const otherRoot = join(root, '..', 'other-brain');
    mkdirSync(otherRoot);
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [otherSourceId, otherRoot]);
    await claimWorktree(engine, otherSourceId, otherRoot);
    await seed(engine, sourceId);
    await seed(engine, otherSourceId);
    const selectedBefore = (await engine.readPageSnapshot('people/example', { sourceId }))!;
    const otherBefore = (await engine.readPageSnapshot('people/example', { sourceId: otherSourceId }))!;
    const otherFactsBefore = await engine.executeRaw(
      'SELECT id,fact,valid_until,consolidated_at,consolidated_into FROM facts WHERE source_id=$1 ORDER BY id', [otherSourceId]);
    const otherFile = join(otherRoot, 'people/example.md');
    const otherBytes = readFileSync(otherFile, 'utf8');
    const otherModified = statSync(otherFile).mtimeMs;
    expect(otherFactsBefore).toHaveLength(3);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');

    const report = await runCycle(engine, { brainDir: root, phases: ['consolidate'], sourceId });

    const phase = report.phases.find(result => result.phase === 'consolidate');
    expect(phase?.status).toBe('ok');
    expect(await engine.executeRaw('SELECT id FROM facts WHERE source_id=$1 AND consolidated_at IS NOT NULL', [sourceId])).toHaveLength(3);
    expect(await engine.executeRaw('SELECT id,fact,valid_until,consolidated_at,consolidated_into FROM facts WHERE source_id=$1 ORDER BY id', [otherSourceId]))
      .toEqual(otherFactsBefore);
    expect(phase?.details.facts_consolidated).toBe(3);
    expect(phase?.details.takes_written).toBe(1);
    expect(await engine.executeRaw('SELECT id FROM takes WHERE page_id=$1', [selectedBefore.page.id])).toHaveLength(1);
    expect(await engine.executeRaw('SELECT id FROM takes WHERE page_id=$1', [otherBefore.page.id])).toHaveLength(0);
    const selectedAfter = (await engine.readPageSnapshot('people/example', { sourceId }))!;
    expect(selectedAfter.revision).not.toBe(selectedBefore.revision);
    expect(selectedAfter.page.compiled_truth).toContain('Example claim 0');
    expect(parseMarkdown(readFileSync(join(root, 'people/example.md'), 'utf8')))
      .toEqual(parseMarkdown(serializePageToMarkdown(selectedAfter.page, selectedAfter.tags)));
    expect((await engine.readPageSnapshot('people/example', { sourceId: otherSourceId }))!.revision).toBe(otherBefore.revision);
    expect(readFileSync(otherFile, 'utf8')).toBe(otherBytes);
    expect(statSync(otherFile).mtimeMs).toBe(otherModified);
  });
}, 30_000);

test('managed disabled public phases perform no admission or owner work', async () => {
  await fixture(async (engine, sourceId, root) => {
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    expect((await runPhasePatterns(engine, { brainDir: root, sourceId, dryRun: false })).status).toBe('skipped');
    expect((await runPhaseSynthesize(engine, { brainDir: root, sourceId, dryRun: false })).status).toBe('skipped');
    expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1', [sourceId])).toHaveLength(0);
    expect(await getWorktreeBinding(engine, sourceId)).toBeNull();
  }, false);
});

test('managed enabled synthesis and patterns refuse a missing owner before provider work', async () => {
  await fixture(async (engine, sourceId, root) => {
    await engine.setConfig('dream.synthesize.enabled', 'true');
    await engine.setConfig('dream.patterns.enabled', 'true');
    for (let i = 0; i < 3; i++) await engine.executeRaw(
      "INSERT INTO pages(source_id,slug,type,title,compiled_truth) VALUES($1,$2,'note','Reflection','Example evidence')",
      [sourceId, `wiki/personal/reflections/missing-owner-${i}`]);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    let calls = 0;
    __setChatTransportForTests(async () => { calls++; throw new Error('Unexpected fixture provider call'); });
    try {
      for (const phase of [runPhaseSynthesize, runPhasePatterns]) {
        const result = await phase(engine, { brainDir: root, sourceId, dryRun: false });
        expect(result.status).toBe('fail');
        expect(result.error?.message).toContain('canonical owner');
      }
      expect(calls).toBe(0);
    } finally { __setChatTransportForTests(null); }
    expect(await engine.executeRaw('SELECT id FROM minion_jobs WHERE data->>\'source_id\'=$1', [sourceId])).toHaveLength(0);
  }, false);
});

test('managed consolidation publishes take, facts, canonical page, and file together and reruns exactly once', async () => {
  await fixture(async (engine, sourceId, root) => {
    await seed(engine, sourceId);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const result = await runPhaseConsolidate(engine, { sourceId, minOldestAgeMs: 0 });
    expect(result.details.facts_consolidated).toBe(3);
    expect(result.details.takes_written).toBe(1);
    const page = (await engine.readPageSnapshot('people/example', { sourceId }))!;
    expect(page.page.compiled_truth).toContain('Example claim 0');
    expect(parseMarkdown(readFileSync(join(root, 'people/example.md'), 'utf8'))).toEqual(parseMarkdown(serializePageToMarkdown(page.page, page.tags)));
    const facts = await engine.executeRaw<{ consolidated_into: number }>('SELECT consolidated_into FROM facts WHERE source_id=$1', [sourceId]);
    expect(facts.every(f => f.consolidated_into === facts[0].consolidated_into && f.consolidated_into > 0)).toBe(true);
    expect((await runPhaseConsolidate(engine, { sourceId, minOldestAgeMs: 0 })).details.facts_consolidated).toBe(0);
    expect(await engine.executeRaw('SELECT id FROM takes WHERE page_id=$1', [page.page.id])).toHaveLength(1);
    const modified = statSync(join(root, 'people/example.md')).mtimeMs;
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await seedFacts(engine, sourceId, 'people/example');
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const refreshed = await runPhaseConsolidate(engine, { sourceId, minOldestAgeMs: 0 });
    expect(refreshed.details.facts_consolidated).toBe(3);
    expect(refreshed.details.takes_written).toBe(0);
    expect(await engine.executeRaw('SELECT id FROM takes WHERE page_id=$1', [page.page.id])).toHaveLength(1);
    expect(statSync(join(root, 'people/example.md')).mtimeMs).toBe(modified);
  });
}, 30_000);

test('managed dry-run and private facts never publish takes or consolidate evidence', async () => {
  await fixture(async (engine, sourceId) => {
    await seed(engine, sourceId);
    await seed(engine, sourceId, 'people/private-example', 'private');
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    expect((await runPhaseConsolidate(engine, { sourceId, dryRun: true, minOldestAgeMs: 0 })).details.facts_consolidated).toBe(3);
    expect(await engine.executeRaw('SELECT id FROM facts WHERE source_id=$1 AND consolidated_at IS NOT NULL', [sourceId])).toHaveLength(0);
    await runPhaseConsolidate(engine, { sourceId, minOldestAgeMs: 0 });
    expect(await engine.executeRaw("SELECT id FROM facts WHERE source_id=$1 AND visibility='private' AND consolidated_at IS NOT NULL", [sourceId])).toHaveLength(0);
  });
}, 30_000);

test('managed consolidation selects eligible world facts before limiting newer private facts', async () => {
  await fixture(async (engine, sourceId) => {
    await seed(engine, sourceId);
    await engine.executeRaw(`INSERT INTO facts(source_id,entity_slug,fact,kind,source,visibility,confidence,valid_from)
      SELECT $1,'people/example','Private example '||n,'fact','test','private',0.9,'2026-02-01'::timestamptz
      FROM generate_series(1,101) n`, [sourceId]);
    const privateBefore = await engine.executeRaw("SELECT * FROM facts WHERE source_id=$1 AND visibility='private' ORDER BY id", [sourceId]);
    expect(privateBefore).toHaveLength(101);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const result = await runPhaseConsolidate(engine, { sourceId, minOldestAgeMs: 0 });
    expect(result.status).toBe('ok');
    expect(result.details.facts_consolidated).toBe(3);
    expect(result.details.takes_written).toBe(1);
    expect(await engine.executeRaw("SELECT * FROM facts WHERE source_id=$1 AND visibility='private' ORDER BY id", [sourceId])).toEqual(privateBefore);
    expect(await engine.executeRaw("SELECT id FROM facts WHERE source_id=$1 AND visibility='world' AND consolidated_at IS NOT NULL", [sourceId])).toHaveLength(3);
  });
}, 30_000);

for (const retirement of ['inactive', 'resolved'] as const) {
  test(`public managed consolidation preserves evidence when the matching take is ${retirement}`, async () => {
    await fixture(async (engine, sourceId, root) => {
      await seed(engine, sourceId);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      const ctx = { engine, sourceId, remote: false as const, config: { engine: engine.kind, embedding_disabled: true },
        dryRun: false, logger: { info() {}, warn() {}, error() {} } };
      const added = await submitPageMutation(ctx, { operation: 'takes_add', params: { slug: 'people/example',
        claim: 'Example claim 0', kind: 'fact', holder: 'self', weight: 0.9, request_id: randomUUID() } });
      await submitPageMutation(ctx, { operation: retirement === 'inactive' ? 'takes_supersede' : 'takes_resolve', params: {
        slug: 'people/example', row_num: added.row_num, request_id: randomUUID(),
        ...(retirement === 'inactive' ? { claim: 'Replacement claim' } : { quality: 'correct', evidence: 'Verified fixture evidence' }),
      } });
      const before = (await engine.readPageSnapshot('people/example', { sourceId }))!;
      const bytes = readFileSync(join(root, 'people/example.md'), 'utf8');
      const result = await runPhaseConsolidate(engine, { sourceId, minOldestAgeMs: 0 });
      expect(result.details.facts_consolidated).toBe(0);
      expect(result.details.takes_written).toBe(0);
      expect(result.status).toBe('skipped');
      expect(result.details.reason).toBe('retired_take');
      expect(result.details.clusters_skipped_retired).toBe(1);
      expect(await engine.executeRaw('SELECT id FROM facts WHERE source_id=$1 AND consolidated_at IS NOT NULL', [sourceId])).toHaveLength(0);
      expect((await engine.readPageSnapshot('people/example', { sourceId }))!.revision).toBe(before.revision);
      expect(readFileSync(join(root, 'people/example.md'), 'utf8')).toBe(bytes);
      const [receipt] = await engine.executeRaw<{ outcome: Record<string, unknown> }>(
        "SELECT outcome FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_maintenance_consolidate'", [sourceId]);
      expect(receipt.outcome).toMatchObject({ status: 'skipped', reason: 'retired_take', facts_consolidated: 0, takes_written: 0 });
    });
  }, 30_000);
}

for (const change of ['derived', 'semantic'] as const) {
  test(`public admitted consolidation ${change === 'derived' ? 'ignores unchanged vectors and embedding telemetry' : 'rejects a changed semantic fact'}`, async () => {
    await fixture(async (engine, sourceId) => {
      await seed(engine, sourceId);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      const lock = (await acquireWorktree((await getWorktreeBinding(engine, sourceId))!, 5000))!;
      expect(lock).not.toBeNull();
      try {
        await expect(runPhaseConsolidate(engine, { sourceId, minOldestAgeMs: 0 })).rejects.toMatchObject({ code: 'write_pending' });
        await disposePersistenceConsumer(engine);
      } finally { await lock.release(); }
      const row = (await claimNextWrite(engine, localHostId()))!;
      const prepared = await prepareMaintenanceMutation(engine, row, { engine: engine.kind, embedding_disabled: true });
      await engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], async () => {
        await tx.executeRaw(change === 'derived'
          ? 'UPDATE facts SET embedding=embedding,embedded_at=now() WHERE source_id=$1'
          : "UPDATE facts SET fact=fact||' changed' WHERE source_id=$1", [sourceId]);
      }));
      const outcome = await publishMutation(engine, row, prepared, localHostId());
      expect(outcome.state).toBe(change === 'derived' ? 'committed' : 'conflict');
      expect(await engine.executeRaw('SELECT id FROM facts WHERE source_id=$1 AND consolidated_at IS NOT NULL', [sourceId]))
        .toHaveLength(change === 'derived' ? 3 : 0);
      if (change === 'derived') {
        const retained = JSON.stringify(row.intent);
        expect(retained).not.toContain('"embedding"');
        expect(retained).not.toContain('"embedded_at"');
      }
    });
  }, 40_000);
}

test('consolidation retains a bounded semantic intent and honors configured admission byte quotas', async () => {
  await fixture(async (engine, sourceId) => {
    await seed(engine, sourceId);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const limits = await readJournalLimits(engine);
    expect(limits.principalIntentBytes).toBe(32 * 1024 ** 2);
    expect(limits.brainIntentBytes).toBe(256 * 1024 ** 2);
    const key = 'persistence.limits.principal_intent_bytes';
    const original = await engine.getConfig(key);
    try {
      await engine.setConfig(key, '512');
      await expect(runPhaseConsolidate(engine, { sourceId, minOldestAgeMs: 0 })).rejects.toMatchObject({ code: 'queue_capacity' });
      expect(await engine.executeRaw('SELECT id FROM facts WHERE source_id=$1 AND consolidated_at IS NOT NULL', [sourceId])).toHaveLength(0);
      await engine.setConfig(key, '8192');
      expect((await runPhaseConsolidate(engine, { sourceId, minOldestAgeMs: 0 })).details.facts_consolidated).toBe(3);
      const [row] = await engine.executeRaw<WriteRequest>(
        "SELECT * FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_maintenance_consolidate'", [sourceId]);
      expect(Number(row.intent_bytes)).toBeLessThan(8192);
      expect(JSON.stringify(row.intent)).not.toContain('"embedding"');
      expect(JSON.stringify(row.intent)).not.toContain('"embedded_at"');
    } finally {
      if (original === null) await engine.executeRaw('DELETE FROM config WHERE key=$1', [key]);
      else await engine.setConfig(key, original);
    }
  });
}, 30_000);

test('paused owner retains an admitted consolidation and a fresh process publishes without resubmission', async () => {
  await fixture(async (engine, sourceId, root) => {
    await seed(engine, sourceId);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const binding = (await getWorktreeBinding(engine, sourceId))!;
    const lock = (await acquireWorktree(binding, 5000))!;
    expect(lock).not.toBeNull();
    try {
      await expect(runPhaseConsolidate(engine, { sourceId, minOldestAgeMs: 0 })).rejects.toMatchObject({ code: 'write_pending' });
      await engine.executeRaw("UPDATE persistence_worktrees SET state='draining' WHERE id=$1::uuid", [binding.worktree_id]);
      await disposePersistenceConsumer(engine);
      expect(await engine.executeRaw('SELECT id FROM facts WHERE source_id=$1 AND consolidated_at IS NOT NULL', [sourceId])).toHaveLength(0);
      expect(readFileSync(join(root, 'people/example.md'), 'utf8')).not.toContain('Example claim');
    } finally { await lock.release(); }
    const [row] = await engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_maintenance_consolidate'", [sourceId]);
    expect(row).toBeDefined();
    startPersistenceConsumer(engine, { engine: engine.kind, embedding_disabled: true });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect((await getWriteRequestById(engine, row.id))!.state).toBe('queued');
    await disposePersistenceConsumer(engine);
    await engine.executeRaw("UPDATE persistence_worktrees SET state='active' WHERE id=$1::uuid", [binding.worktree_id]);
    let databaseUrl: string | undefined;
    if (engine.kind === 'postgres') {
      const [db] = await engine.executeRaw<{ name: string }>('SELECT current_database() AS name');
      const url = new URL(process.env.DATABASE_URL!); url.pathname = `/${db.name}`; databaseUrl = url.toString();
    }
    const config = { engine: engine.kind, database_path: engine.kind === 'pglite' ? dataDir : undefined,
      database_url: databaseUrl, embedding_disabled: true };
    await engine.disconnect();
    const child = Bun.spawn([process.execPath, 'test/helpers/maintenance-restart.ts'], {
      cwd: process.cwd(), env: { ...process.env, GBRAIN_MAINTENANCE_TEST_CONFIG: JSON.stringify(config),
      GBRAIN_MAINTENANCE_TEST_REQUEST: row.id }, stdout: 'pipe', stderr: 'pipe' });
    const code = await child.exited;
    const stderr = await new Response(child.stderr).text();
    await engine.connect(config);
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
    expect((await getWriteRequestById(engine, row.id))!.state).toBe('committed');
    expect(readFileSync(join(root, 'people/example.md'), 'utf8')).toContain('Example claim');
  });
}, 60_000);

test('retained page output conflicts after a concurrent revision and rejects replaced source authority', async () => {
  await fixture(async (engine, sourceId) => {
    await seed(engine, sourceId);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const authority = (await maintenancePreflight(engine, sourceId))!;
    const before = (await engine.readPageSnapshot('people/example', { sourceId }))!;
    await publishMaintenancePage(engine, authority, 'people/example', '---\ntitle: Example\ntype: note\n---\nNew revision', { expectedRevision: before.revision });
    await expect(publishMaintenancePage(engine, authority, 'people/example', 'Stale output', { expectedRevision: before.revision }))
      .rejects.toMatchObject({ code: 'revision_conflict' });
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw('DELETE FROM sources WHERE id=$1', [sourceId]);
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    await expect(publishMaintenancePage(engine, authority, 'notes/replaced', 'Never published', { expectedRevision: null }))
      .rejects.toMatchObject({ code: 'source_changed' });
  });
}, 30_000);

test('remote queued jobs cannot acquire fabricated local maintenance authority', async () => {
  await fixture(async (engine, sourceId) => {
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    await expect(withSubmissionAuthority({ version: 1, kind: 'remote_agent', principal: { kind: 'oauth_client', id: 'example-client' },
      grant: { scopes: ['admin'], sourceId, sourceCreatedAt: new Date().toISOString(), allowedTools: ['put_page'], allowedSlugPrefixes: ['*'] },
      payloadHash: '0'.repeat(64) }, () => maintenancePreflight(engine, sourceId))).rejects.toMatchObject({ code: 'permission_denied' });
  });
});

test('publication intersects the accepted local grant with current revocation', async () => {
  await fixture(async (engine, sourceId) => {
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const authority = (await maintenancePreflight(engine, sourceId))!;
    await revokeLocalWriter(engine, authority.writer.principal.id);
    await expect(publishMaintenancePage(engine, authority, 'notes/revoked', 'Forbidden output', { expectedRevision: null }))
      .rejects.toMatchObject({ code: 'permission_denied' });
    expect(await engine.readPageSnapshot('notes/revoked', { sourceId })).toBeNull();
  });
});

for (const failure of ['commit', 'withdrawal'] as const) {
  test(`consolidation ${failure} failure leaves facts unconsolidated and take/file unchanged`, async () => {
    await fixture(async (engine, sourceId, root) => {
      await seed(engine, sourceId);
      const original = readFileSync(join(root, 'people/example.md'), 'utf8');
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      const binding = (await getWorktreeBinding(engine, sourceId))!;
      const lock = (await acquireWorktree(binding, 5000))!;
      expect(lock).not.toBeNull();
      try {
        await expect(runPhaseConsolidate(engine, { sourceId, minOldestAgeMs: 0 })).rejects.toMatchObject({ code: 'write_pending' });
        await disposePersistenceConsumer(engine);
      } finally { await lock.release(); }
      const row = (await claimNextWrite(engine, localHostId()))!;
      expect(row.source_id).toBe(sourceId);
      const prepared = await prepareMaintenanceMutation(engine, row, { engine: engine.kind, embedding_disabled: true });
      if (failure === 'withdrawal') {
        const [fact] = await engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE source_id=$1 ORDER BY id LIMIT 1', [sourceId]);
        await submitForgetMutation({ engine, sourceId, remote: false, config: { engine: engine.kind }, dryRun: false,
          logger: { info() {}, warn() {}, error() {} } }, 'forget', { id: Number(fact.id), request_id: randomUUID() });
      }
      const outcome = await publishMutation(engine, row, prepared, localHostId(), { boundary: async name => {
        if (failure === 'commit' && name === 'before_commit') throw new Error('Injected fixture commit failure');
      } });
      expect(['failed', 'conflict']).toContain(outcome.state);
      const page = (await engine.readPageSnapshot('people/example', { sourceId }))!;
      expect(await engine.executeRaw('SELECT id FROM takes WHERE page_id=$1', [page.page.id])).toHaveLength(0);
      expect(await engine.executeRaw('SELECT id FROM facts WHERE source_id=$1 AND consolidated_at IS NOT NULL', [sourceId])).toHaveLength(0);
      expect(readFileSync(join(root, 'people/example.md'), 'utf8')).toBe(original);
    });
  }, 40_000);
}

test('managed synthesis drives real children and publishes repaired provenance plus summary without repeated model calls', async () => {
  await fixture(async (engine, sourceId, root) => {
    await seed(engine, sourceId);
    const transcript = join(root, '2026-09-20-session.txt');
    const quote = 'we charge for durability because reliable memories should survive every tool';
    writeFileSync(transcript, `User: ${quote}.\n${'Assistant: Discuss the long term roadmap.\n'.repeat(15)}`);
    await engine.setConfig('dream.synthesize.enabled', 'true');
    await engine.setConfig('dream.synthesize.cooldown_hours', '0');
    await engine.setConfig('dream.synthesize.min_chars', '100');
    await engine.setConfig('dream.synthesize.link_manifest', 'false');
    await engine.setConfig('dream.synthesize.mode', 'oneshot');
    await engine.setConfig('models.dream.synthesize', 'anthropic:claude-sonnet-4-6');
    await engine.setConfig('models.dream.triage', 'anthropic:claude-sonnet-4-6');
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    let calls = 0;
    __setChatTransportForTests(async opts => {
      calls++;
      const user = String(opts.messages?.[0]?.content ?? '');
      const hash = /hash suffix \(USE THIS in slugs\): ([a-z0-9-]+)/i.exec(user)?.[1] ?? 'missing';
      const text = (opts.system ?? '').startsWith('You triage a conversation transcript')
        ? JSON.stringify({ score: 0.9, content_type: 'reflection', segments: [{ quote, note: 'evidence' }], entities: [], reasons: ['durable insight'] })
        : JSON.stringify({ pages: [{ slug: `wiki/personal/reflections/session-${hash}`, title: 'Session', type: 'note',
          body: `A memory strategy with [[people/example]]. Allegedly: "an entirely invented quotation that should lose its marks".` }], skipped: false });
      return { text, blocks: [{ type: 'text', text }], stopReason: 'end',
        usage: { input_tokens: 100, output_tokens: 100, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: opts.model!, providerId: 'anthropic' };
    });
    try {
      await withEnv({ ANTHROPIC_API_KEY: 'sk-test-maintenance' }, async () => {
        const opts = { brainDir: root, sourceId, dryRun: false, inputFile: transcript, date: '2026-09-20' };
        const binding = (await getWorktreeBinding(engine, sourceId))!;
        const completion = await engine.getConfig('dream.synthesize.last_completion_ts');
        const pending = await runPhaseSynthesize(engine, { ...opts, yieldDuringPhase: async () => {
          const rows = await engine.executeRaw("SELECT id FROM minion_jobs WHERE status='completed' AND data->>'source_id'=$1 LIMIT 1", [sourceId]);
          if (rows.length) await engine.executeRaw("UPDATE persistence_worktrees SET state='draining' WHERE id=$1::uuid", [binding.worktree_id]);
        } });
        expect(pending.status).toBe('fail');
        expect(await engine.getConfig('dream.synthesize.last_completion_ts')).toBe(completion);
        const retainedCalls = calls;
        await disposePersistenceConsumer(engine);
        await engine.executeRaw('DELETE FROM dream_verdicts');
        await engine.executeRaw("UPDATE persistence_worktrees SET state='active' WHERE id=$1::uuid", [binding.worktree_id]);
        const result = await runPhaseSynthesize(engine, opts);
        expect(result.status).toBe('ok');
        expect(calls).toBe(retainedCalls);
        expect(result.details.pages_written).toBe(1);
        const slug = (result.details.written_slugs as string[])[0];
        const page = (await engine.readPageSnapshot(slug, { sourceId }))!;
        expect(page.page.frontmatter.dream_generated).toBe(true);
        expect(page.page.compiled_truth).not.toContain('"an entirely invented');
        expect(parseMarkdown(readFileSync(join(root, `${slug}.md`), 'utf8'))).toEqual(parseMarkdown(serializePageToMarkdown(page.page, page.tags)));
        const summary = String(result.details.summary_slug);
        expect(readFileSync(join(root, `${summary}.md`), 'utf8')).toContain('Dream cycle 2026-09-20');
        const before = calls;
        await disposePersistenceConsumer(engine);
        const replay = await runPhaseSynthesize(engine, opts);
        expect(replay.status).toBe('ok');
        expect(calls).toBe(before);
        await engine.setConfig('dream.synthesize.summary_file_write', 'false');
        const dbOnly = await runPhaseSynthesize(engine, { ...opts, date: '2026-09-21' });
        expect(dbOnly.status).toBe('ok');
        expect(await engine.readPageSnapshot(String(dbOnly.details.summary_slug), { sourceId })).not.toBeNull();
        expect(existsSync(join(root, `${dbOnly.details.summary_slug}.md`))).toBe(false);
        expect(calls).toBe(before);
        await engine.setConfig('dream.synthesize.summary_file_write', 'true');
      });
    } finally { __setChatTransportForTests(null); }
  });
}, 90_000);

test('managed patterns scopes evidence and publishes through the real admitted subagent operation', async () => {
  await fixture(async (engine, sourceId, root) => {
    for (let i = 0; i < 3; i++) await seed(engine, sourceId, `wiki/personal/reflections/example-${i}`);
    await engine.executeRaw("INSERT INTO pages(source_id,slug,type,title,compiled_truth) VALUES('default',$1,'note','Foreign','Foreign source evidence')",
      [`wiki/personal/reflections/foreign-${sourceId}`]);
    await engine.executeRaw("INSERT INTO pages(source_id,slug,type,title,compiled_truth,frontmatter) VALUES($1,$2,'note','Private','Private evidence',$3::text::jsonb)",
      [sourceId, 'wiki/personal/reflections/private-example', JSON.stringify({ visibility: 'private' })]);
    await engine.setConfig('dream.patterns.enabled', 'true');
    await engine.setConfig('models.dream.patterns', 'anthropic:claude-sonnet-4-6');
    await engine.setConfig('agent.use_gateway_loop', 'true');
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    let calls = 0;
    __setChatTransportForTests(async opts => {
      calls++;
      const text = calls === 1 ? '' : 'Saved the pattern.';
      return { text, blocks: calls === 1 ? [{ type: 'tool-call', toolCallId: 'pattern-write', toolName: 'brain_put_page', input: {
        slug: 'wiki/personal/patterns/example', content: '---\ntitle: Example pattern\ntype: note\n---\nA recurring theme in [[wiki/personal/reflections/example-0]].',
      } }] : [{ type: 'text', text }], stopReason: calls === 1 ? 'tool_calls' : 'end',
      usage: { input_tokens: 100, output_tokens: 100, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: opts.model!, providerId: 'anthropic' };
    });
    try {
      await withEnv({ ANTHROPIC_API_KEY: 'sk-test-maintenance' }, async () => {
        const result = await runPhasePatterns(engine, { brainDir: root, sourceId, dryRun: false, once: true });
        expect(result.status).toBe('ok');
        expect(result.details.reflections_considered).toBe(3);
        expect(result.details.patterns_written).toBe(1);
        const page = (await engine.readPageSnapshot('wiki/personal/patterns/example', { sourceId }))!;
        expect(parseMarkdown(readFileSync(join(root, 'wiki/personal/patterns/example.md'), 'utf8'))).toEqual(parseMarkdown(serializePageToMarkdown(page.page, page.tags)));
        const before = calls;
        const replay = await runPhasePatterns(engine, { brainDir: root, sourceId, dryRun: false, once: true });
        expect(replay.status).toBe('ok');
        expect(calls).toBe(before);
      });
    } finally { __setChatTransportForTests(null); }
  });
}, 90_000);
