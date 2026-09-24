import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { parseMarkdown, serializePageToMarkdown } from '../../src/core/markdown.ts';
import { parseFactsFence } from '../../src/core/facts-fence.ts';
import { operationsByName } from '../../src/core/operations.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { registerLocalWriter, withVerifiedLocalRegistration } from '../../src/core/persistence/identity.ts';
import { runReconcileApply, runReconcilePreview } from '../../src/core/persistence/reconcile.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { withEnv } from '../helpers/with-env.ts';

const pooled = process.env.GBRAIN_PGBOUNCER_URL;
const direct = process.env.GBRAIN_PGBOUNCER_DIRECT_URL;
const available = Boolean(pooled && direct);
if (process.env.GBRAIN_CI_REQUIRE_PGBOUNCER === '1' && !available) throw new Error('Reconciliation requires the configured CI PgBouncer fixture.');
let home: string;
let database: string;
let admin: ReturnType<typeof postgres> | undefined;
let engine: PostgresEngine | undefined;

beforeAll(async () => {
  if (!available) return;
  assertSafeE2eDatabaseUrl(direct!);
  home = mkdtempSync(join(tmpdir(), 'gbrain-reconcile-pooled-'));
  database = `gbrain_test_reconcile_pool_${randomUUID().replaceAll('-', '')}`;
  admin = postgres(direct!, { max: 1, prepare: false });
  await admin.unsafe(`CREATE DATABASE ${database}`);
  const url = new URL(pooled!);
  url.pathname = `/${database}`;
  engine = new PostgresEngine();
  await withEnv({ GBRAIN_HOME: home }, async () => {
    await engine!.connect({ database_url: url.toString(), poolSize: 4 });
    await engine!.initSchema();
  });
}, 120_000);

afterAll(async () => {
  if (engine) {
    await withEnv({ GBRAIN_HOME: home }, async () => { await disposePersistenceConsumer(engine!); await engine!.disconnect(); });
  }
  if (admin) {
    try { if (database) await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); }
    finally { await admin.end(); }
  }
  if (home) rmSync(home, { recursive: true, force: true });
});

for (const enabled of [false, true]) {
  test.skipIf(!available)(`transaction-pooled repair restores a private memory write with activation=${enabled}`, async () => {
    await withEnv({ GBRAIN_HOME: home, OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined }, async () => {
      const db = engine!;
      await disposePersistenceConsumer(db);
      await db.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      const source = `pool-${randomUUID().slice(0, 8)}`;
      const root = join(home, source), slug = 'people/example';
      mkdirSync(join(root, 'people'), { recursive: true });
      await db.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [source, root]);
      await importFromContent(db, slug, '---\ntitle: Example\ntype: person\ndatabase_field: kept\n---\nSynthetic biography.\n',
        { sourceId: source, sourcePath: 'people/example.md', noEmbed: true, remote: false });
      const before = (await db.readPageSnapshot(slug, { sourceId: source }))!;
      const file = join(root, 'people/example.md');
      writeFileSync(file, serializePageToMarkdown({ ...before.page, frontmatter: { file_field: 'kept' } }, before.tags));
      const binding = await claimWorktree(db, source, root);
      const registration = await registerLocalWriter(db, 'cli');
      await db.executeRaw('UPDATE persistence_brain SET enabled=$1 WHERE singleton=1', [enabled]);
      await withVerifiedLocalRegistration(db, registration, async () => {
        const ctx: OperationContext = { engine: db, remote: false, sourceId: source, config: { engine: 'postgres' }, dryRun: false,
          logger: { info() {}, warn() {}, error() {} } };
        const fact = 'Prefers the synthetic morning review.', provenance = 'Synthetic operator conversation';
        const blockedId = randomUUID(), repairId = randomUUID(), memoryId = randomUUID();
        await expect(operationsByName.remember!.handler(ctx, { fact, provenance, entity: slug, visibility: 'private', request_id: blockedId }))
          .rejects.toMatchObject({ code: 'scope_denied', writeError: 'source_changed' });
        const { preview } = await runReconcilePreview(db, { source_id: source, slug });
        expect(preview.status).toBe('ready');
        const applied = await runReconcileApply(db, { source_id: source, slug, preview, request_id: repairId });
        expect(applied.state).toBe('committed');
        const saved = await operationsByName.remember!.handler(ctx, { fact, provenance, entity: slug, visibility: 'private', request_id: memoryId }) as Record<string, unknown>;
        expect(saved).toMatchObject({ status: 'inserted', state: 'committed', request_id: memoryId });
        const current = (await db.readPageSnapshot(slug, { sourceId: source }))!;
        expect(current.page.frontmatter).toMatchObject({ database_field: 'kept', file_field: 'kept' });
        expect(parseFactsFence(current.page.compiled_truth).facts).toEqual(expect.arrayContaining([
          expect.objectContaining({ claim: fact, visibility: 'private', source: provenance }),
        ]));
        expect(parseMarkdown(readFileSync(file, 'utf8'), slug).compiled_truth).toBe(current.page.compiled_truth);
        expect(await db.executeRaw('SELECT fact,visibility,source FROM facts WHERE id=$1 AND source_id=$2', [Number(saved.id), source]))
          .toEqual([{ fact, visibility: 'private', source: provenance }]);
        expect(await runReconcileApply(db, { source_id: source, slug, preview, request_id: repairId })).toEqual(applied);
        expect((await db.readPageSnapshot(slug, { sourceId: source }))?.revision).toBe(current.revision);
        expect(await db.executeRaw('SELECT owner_epoch::text AS epoch FROM persistence_worktrees WHERE id=$1::uuid', [binding.worktree_id]))
          .toEqual([{ epoch: String(binding.owner_epoch) }]);
        expect(await db.executeRaw('SELECT last_commit,last_sync_at FROM sources WHERE id=$1', [source]))
          .toEqual([{ last_commit: null, last_sync_at: null }]);
        expect(await db.executeRaw('SELECT enabled FROM persistence_brain WHERE singleton=1')).toEqual([{ enabled }]);
      });
      await disposePersistenceConsumer(db);
    });
  }, 120_000);
}
