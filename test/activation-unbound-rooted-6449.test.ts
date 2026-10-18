/**
 * #6449: a brain with `sync.write_through=false` is database-only, and `writer
 * status` already reports a rooted source with no canonical owner as
 * `database_only`. Activation disagreed: the same source was refused
 * `writer_registration_required`, so a database-only brain could not enter
 * managed mode without inventing a checkout owner per source.
 *
 * Fix: activation lists such a source under `database_only_sources` and goes
 * ahead; with write_through on, the refusal names the `writer claim`
 * (preview first) and the database-only alternative. [R6] pins the flip:
 * after a database-only activation, turning `sync.write_through` back on must
 * not start an unreviewed first-write claim on the still-unbound source
 * (activation records the listed sources in `persistence.database_only_sources`
 * and the PGLite auto-claim skips them; deactivation clears the list); the
 * write refuses with the claim named, or stays database-only under
 * `persistence.unbound_write`, and no file is ever written. Managed `sync` on
 * that source names the claim too.
 *
 * Contributed by @uncfreak1255-code (diagnosis, #5737).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { testWaitMs } from './helpers/wait-for.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { activatePersistence } from '../src/core/persistence/activation.ts';
import { writerOnboardingPreflight } from '../src/core/persistence/onboarding.ts';
import { managedPersistenceEnabled } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { resolveManagedSyncContext } from '../src/core/persistence/sync-discovery.ts';
import { deactivatePersistence } from '../src/core/persistence/deactivation.ts';
import { DATABASE_ONLY_SOURCES_KEY } from '../src/core/persistence/unbound-source.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const logger = { info() {}, warn() {}, error() {} };
const backends = testBackends();
const engines: BrainEngine[] = [];
const dataDir = mkdtempSync(join(tmpdir(), 'gbrain-6449-db-'));
let closePostgres: (() => Promise<void>) | undefined;

beforeAll(async () => {
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({ database_path: dataDir }); await engine.initSchema(); engines.push(engine);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push(pg.engine); closePostgres = pg.close;
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.(); rmSync(dataDir, { recursive: true, force: true });
});

async function settledEffects(engine: BrainEngine): Promise<void> {
  const deadline = Date.now() + testWaitMs(30_000);
  while (true) {
    const open = await engine.executeRaw<{ id: string; kind: string; state: string }>(
      "SELECT id::text AS id, kind, state FROM persistence_effects WHERE state<>'committed' OR recovery IS NOT NULL ORDER BY id");
    if (!open.length) return;
    if (Date.now() > deadline) throw new Error(`effects did not settle: ${JSON.stringify(open)}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

type Outcome = { state: string; code?: string; detail?: string; suggestion?: string; write_through?: { skipped?: string } };
const outcome = (promise: Promise<unknown>): Promise<Outcome> => promise.then(
  receipt => receipt as Outcome,
  (error: { code?: string; detail?: string; suggestion?: string }) => ({ state: 'refused', code: error.code, detail: error.detail, suggestion: error.suggestion }));

test('a rooted unbound source activates database-only when write_through is off; the flip never starts writing files', async () => {
  for (const engine of engines) await databaseOnlyActivation(engine);
}, 240_000);

async function databaseOnlyActivation(engine: BrainEngine): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-6449-'));
  const root = join(dir, 'vault'); mkdirSync(root);
  const sourceId = `vault-${randomUUID().slice(0, 8)}`;
  try {
    await withEnv({ GBRAIN_HOME: join(dir, 'home'), DATABASE_URL: engine.kind === 'postgres' ? process.env.DATABASE_URL : undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
      const bindings = async () => engine.executeRaw('SELECT source_id FROM persistence_source_bindings WHERE source_id=$1', [sourceId]);
      const sourceStatus = async () => (await writerOnboardingPreflight(engine)).sources.find(s => s.source_id === sourceId)?.state;
      // Managed mode fences every recorded source path from unmanaged writers with its `.gbrain-managed` marker (filesystem-guard.ts); that
      // marker is the only thing that may ever appear under a database-only root. No page file does.
      const filesUnderRoot = () => readdirSync(root).filter(name => name !== '.gbrain-managed');

      // write_through on: the refusal stands, and now names the claim (preview first) and the database-only alternative.
      await engine.setConfig('sync.write_through', 'true');
      expect(await sourceStatus()).toBe('claim_required');
      const refused = await outcome(activatePersistence(engine, { confirmQuiesced: true, dryRun: true }));
      expect(refused).toMatchObject({ state: 'refused', code: 'writer_registration_required' });
      expect(refused.suggestion).toContain(`gbrain sources writer claim ${sourceId} --path ${root} --dry-run --json`);
      expect(refused.suggestion).toContain('gbrain config set sync.write_through false');
      expect(await managedPersistenceEnabled(engine)).toBe(false);

      // write_through off: status says database_only and activation now agrees (before the fix: writer_registration_required).
      await engine.setConfig('sync.write_through', 'false');
      expect(await sourceStatus()).toBe('database_only');
      expect(await activatePersistence(engine, { confirmQuiesced: true, dryRun: true }))
        .toMatchObject({ enabled: false, activated: false, filesystem_sources: 0, database_only_sources: [sourceId] });
      expect(await managedPersistenceEnabled(engine)).toBe(false);
      expect(await activatePersistence(engine, { confirmQuiesced: true }))
        .toMatchObject({ enabled: true, activated: true, filesystem_sources: 0, database_only_sources: [sourceId] });
      expect(await managedPersistenceEnabled(engine)).toBe(true);
      expect(await bindings()).toEqual([]);
      expect(JSON.parse((await engine.getConfig(DATABASE_ONLY_SOURCES_KEY))!)).toEqual([sourceId]);

      // A page write lands database-only with the explicit reason; nothing is written under the root.
      const ctx = { engine, sourceId, remote: false, config: { engine: engine.kind, embedding_disabled: true } as never, dryRun: false, logger } as OperationContext;
      const put = (slug: string, content: string) => outcome(submitPageMutation(ctx, { operation: 'put_page', params: { slug, request_id: randomUUID(), content } }));
      const content = (body: string) => `---\ntype: note\ntitle: Database Only Note\n---\n# Database Only Note\n\n${body}\n`;
      expect(await put('notes/database-only', content('Stored while write_through is off.'))).toMatchObject({ state: 'committed', write_through: { skipped: 'disabled_by_config' } });
      expect(filesUnderRoot()).toEqual([]);

      // [R6] The flip: write_through back on must not auto-claim the source activation accepted database-only.
      await engine.setConfig('sync.write_through', 'true');
      expect(await sourceStatus()).toBe('claim_required');
      const flipped = await put('notes/after-flip', content('Written after the flip.'));
      expect(flipped).toMatchObject({ state: 'refused', code: 'owner_unavailable', detail: 'unbound_source' });
      expect(flipped.suggestion).toContain(`gbrain sources writer claim ${sourceId}`);
      expect(await bindings()).toEqual([]);
      expect(filesUnderRoot()).toEqual([]);
      expect(await engine.executeRaw('SELECT slug FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, 'notes/after-flip'])).toEqual([]);

      // The documented alternative keeps the source database-only under the opt-in; still no claim and no file.
      await engine.setConfig('persistence.unbound_write', 'database_only');
      expect(await put('notes/after-flip', content('Written after the flip.'))).toMatchObject({ state: 'committed', write_through: { skipped: 'unbound_source' } });
      await engine.setConfig('persistence.unbound_write', 'refuse');
      expect(await bindings()).toEqual([]);
      expect(filesUnderRoot()).toEqual([]);

      // Managed sync on the unbound source refuses as before, and the hint names the claim instead of forbidding it.
      const sync = await outcome(resolveManagedSyncContext(engine, { sourceId, noPull: true } as never));
      expect(sync).toMatchObject({ state: 'refused', code: 'owner_unavailable' });
      expect(sync.suggestion).toContain(`gbrain sources writer claim ${sourceId} --path ${root} --dry-run --json`);
      expect(sync.suggestion).not.toContain('do not claim');
      expect(existsSync(root)).toBe(true);

      // Deactivation clears the list; back in classic mode the ordinary PGLite first-write claim applies again.
      // The brain must quiesce first: the committed writes' embedding effects drain asynchronously, and a running
      // effect blocks deactivation (deleting queued rows raced the consumer picking one up).
      await engine.setConfig('sync.write_through', 'false');
      await settledEffects(engine);
      expect(await deactivatePersistence(engine, { requestId: randomUUID() })).toMatchObject({ mode: 'classic', deactivated: true });
      expect(await engine.getConfig(DATABASE_ONLY_SOURCES_KEY)).toBeNull();
    });
  } finally {
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw('DELETE FROM pages WHERE source_id=$1', [sourceId]).catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}
