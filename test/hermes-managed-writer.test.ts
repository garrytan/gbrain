import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree, getWorktreeBinding, managedPersistenceEnabled } from '../src/core/persistence/ownership.ts';
import { readLocalWriter } from '../src/core/persistence/identity.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { registeredManagedRoots } from '../src/core/persistence/root-registry.ts';
import { startDelegatedHermesMaintenance, getDelegatedHermesMaintenanceStatus, shutdownDelegatedHermesMaintenance } from '../src/core/serve-hermes-runner.ts';
import { buildHermesFixture } from './fixtures/transcripts/hermes-fixture-builder.ts';
import { reviewedWriterIntent } from './helpers/writer-admin-intent.ts';
import { withEnv } from './helpers/with-env.ts';

const scratch = process.env.TMPDIR ?? '/tmp';
const root = mkdtempSync(join(scratch, 'gbrain-hermes-managed-writer-'));
const home = join(root, 'home');
const checkout = join(root, 'source');
const sourceId = `hermes-managed-${randomUUID().slice(0, 10)}`;
const stateDb = join(root, 'state.db');
let engine: PGLiteEngine;
let registration: Awaited<ReturnType<typeof readLocalWriter>>;

function createHermesStore(messageCount: number): string {
  const path = buildHermesFixture(root);
  const db = new Database(path);
  try {
    db.exec('DELETE FROM messages; DELETE FROM sessions;');
    const session = db.prepare('INSERT INTO sessions (id, source, display_name, model, started_at, cwd, title) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const message = db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)');
    session.run('managed-writer-session', 'cli', 'managed writer regression', 'model-example', 1785916800,
      '/workspace/synthetic-agent', 'managed writer regression');
    const insert = db.transaction((count: number) => {
      for (let i = 0; i < count; i++) {
        const ts = 1785916805 + i;
        message.run('managed-writer-session', i % 2 === 0 ? 'user' : 'assistant',
          i < 2 ? `Synthetic Hermes message ${i}.` : `Synthetic message ${i}: ${'managed writer content '.repeat(35)}`,
          ts);
      }
    });
    insert(messageCount);
  } finally {
    db.close();
  }
  return path;
}

async function startImport(token: string) {
  const response = await startDelegatedHermesMaintenance(engine,
    { stateDb, sourceId, limit: 10, windowSeconds: 30 }, token, registration, sourceId);
  expect(response).toMatchObject({ ok: true, protocol: 2 });
  let status = getDelegatedHermesMaintenanceStatus(engine, response.jobId!, sourceId);
  for (let i = 0; i < 500 && status.state === 'running'; i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
    status = getDelegatedHermesMaintenanceStatus(engine, response.jobId!, sourceId);
  }
  expect(status.state).toBe('done');
  expect(status.report).toBeTruthy();
  return status.report!;
}

beforeAll(async () => {
  mkdirSync(home, { recursive: true });
  mkdirSync(checkout, { recursive: true });
  execFileSync('git', ['init', '-q', checkout]);
  execFileSync('git', ['-C', checkout, 'config', 'user.name', 'Hermes Test']);
  execFileSync('git', ['-C', checkout, 'config', 'user.email', 'hermes-test@example.invalid']);
  await withEnv({ HOME: home, GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, checkout]);
    await claimWorktree(engine, sourceId, checkout);
    const activated = await runPersistenceAdministration(engine, 'writer_activate', {
      confirm_quiesced: true,
      ...await reviewedWriterIntent(engine, 'writer_activate'),
    });
    expect(activated).toMatchObject({ enabled: true, activated: true, filesystem_sources: 1 });
    expect(await managedPersistenceEnabled(engine)).toBe(true);
    expect((await getWorktreeBinding(engine, sourceId))?.local_path).toBe(checkout);
    expect(registeredManagedRoots()).toContain(checkout);
    expect(existsSync(join(checkout, '.git', 'gbrain-managed.json'))).toBe(true);
    registration = await readLocalWriter(engine, 'cli');
    expect(registration.lane).toBe('cli');
  });
}, 120_000);

afterAll(async () => {
  if (engine) {
    await shutdownDelegatedHermesMaintenance(engine);
    await engine.disconnect();
  }
  rmSync(root, { recursive: true, force: true });
});

test('activated source imports Hermes through the resident owner, persists provenance, and reconciles stale parts', async () => {
  await withEnv({ HOME: home, GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
    createHermesStore(180);
    const first = await startImport('managed-hermes-import-first');
    expect(first.status).toBe('ok');
    expect(first.validation).toMatchObject({ checked: expect.any(Number), missing: [] });
    const baseSlug = first.ingest!.slugsTouched[0]!;
    const firstPages = await engine.executeRaw<{ slug: string }>(
      'SELECT slug FROM pages WHERE source_id=$1 AND slug LIKE $2 AND deleted_at IS NULL ORDER BY slug',
      [sourceId, `${baseSlug}%`]);
    expect(firstPages.length).toBeGreaterThan(1);
    expect(firstPages.map(row => row.slug)).toContain(`${baseSlug}-p2`);
    expect(existsSync(join(checkout, `${baseSlug}.md`))).toBe(true);
    expect(existsSync(join(checkout, `${baseSlug}-p2.md`))).toBe(true);
    const original = await engine.getPage(baseSlug, { sourceId });
    expect(original?.compiled_truth).toContain('Synthetic Hermes message');
    expect(original?.frontmatter).toMatchObject({ transcript_import: { harness: 'hermes', session_id: 'managed-writer-session' } });
    const raw = await engine.getRawData(baseSlug, 'transcript:hermes', { sourceId });
    expect(raw).toHaveLength(1);
    expect(raw[0]?.data).toMatchObject({ session_id: 'managed-writer-session' });
    const provenance = await engine.executeRaw<{ source: string; data: Record<string, unknown> }>(
      `SELECT r.source,r.data FROM raw_data r JOIN pages p ON p.id=r.page_id WHERE p.source_id=$1 AND p.slug=$2`, [sourceId, baseSlug]);
    expect(provenance).toHaveLength(1);
    expect(provenance[0]).toMatchObject({ source: 'transcript:hermes', data: { session_id: 'managed-writer-session' } });

    const replay = await startDelegatedHermesMaintenance(engine,
      { stateDb, sourceId, limit: 10, windowSeconds: 30 }, 'managed-hermes-import-first', registration, sourceId);
    expect(replay.jobId).toBeTruthy();

    createHermesStore(2);
    const shrunk = await startImport('managed-hermes-import-shrink');
    expect(shrunk.ingest!.files.map(file => file.error).filter(Boolean)).toEqual([]);
    expect(shrunk.ingest!.files.flatMap(outcome => outcome.sessions.map(session => session.error).filter(Boolean))).toEqual([]);
    expect(shrunk.reasons).toEqual([]);
    expect(shrunk.ingest!.partsDeleted).toBeGreaterThan(0);
    expect(await engine.getPage(`${baseSlug}-p2`, { sourceId })).toBeNull();
    const tombstone = await engine.readPageSnapshot(`${baseSlug}-p2`, { sourceId, includeDeleted: true });
    expect(tombstone?.page.deleted_at).toBeTruthy();
    expect(existsSync(join(checkout, `${baseSlug}-p2.md`))).toBe(false);

    const again = await startImport('managed-hermes-import-idempotent');
    expect(again.status).toBe('ok');
    expect(again.ingest!.partsDeleted).toBe(0);
    expect(await engine.getPage(`${baseSlug}-p2`, { sourceId })).toBeNull();
    expect((await engine.readPageSnapshot(`${baseSlug}-p2`, { sourceId, includeDeleted: true }))?.page.deleted_at).toBeTruthy();
    const remaining = await engine.executeRaw<{ slug: string }>(
      'SELECT slug FROM pages WHERE source_id=$1 AND slug LIKE $2 AND deleted_at IS NULL ORDER BY slug',
      [sourceId, `${baseSlug}%`]);
    expect(remaining.map(row => row.slug)).toEqual([baseSlug]);
  });
}, 60_000);
