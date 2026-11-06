/**
 * GBRA-190 G4: a forget is a coordinated publication that strikes the page's
 * file before it commits (no withdrawal mirror runs after it); the CLI process
 * that committed it exits without running its queued effects. These pin what
 * the next caller sees:
 * - the file already holds the struck row, so a write to the withdrawn page
 *   commits first time and nothing rewrites the file under it (N5-3);
 * - a forget submitted while a write to the page is in flight queues behind it,
 *   and both commit first time, neither failing as an uncoordinated file edit;
 * - the acknowledged forget leaves the page's retained text searchable (N5-2).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { localHostId, registerLocalWriter } from '../src/core/persistence/identity.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { admitWrite, claimNextWrite, getWriteRequestById } from '../src/core/persistence/journal.ts';
import { publishMutation } from '../src/core/persistence/coordinator.ts';
import { prepareMemoryMutation, submitForgetMutation, submitRememberMutation } from '../src/core/persistence/memory-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const engines: BrainEngine[] = [];
const roots: string[] = [];
const hostId = localHostId();
let closePostgres: (() => Promise<void>) | undefined;
const context = (engine: BrainEngine, sourceId: string): OperationContext => ({ engine, sourceId, remote: false, dryRun: false,
  config: { engine: engine.kind, embedding_disabled: true }, logger: { info() {}, warn() {}, error() {} } });

beforeAll(async () => {
  const backends = testBackends();
  if (backends.includes('pglite')) { const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite); }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push(pg.engine); closePostgres = pg.close;
  }
  for (const engine of engines) await registerLocalWriter(engine, 'cli');
}, 120_000);
afterAll(async () => {
  for (const engine of engines) await disposePersistenceConsumer(engine);
  for (const engine of engines) if (engine instanceof PGLiteEngine) await engine.disconnect();
  await closePostgres?.();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** An entity page with a canonical file and two remembered facts; no consumer is left running. */
async function entity(engine: BrainEngine) {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-withdrawal-followup-')); roots.push(root);
  const sourceId = `followup-${randomUUID()}`, slug = 'people/hazel-example';
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
  const binding = await claimWorktree(engine, sourceId, root, hostId);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const snapshot = await engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], async () => {
    await tx.putPage(slug, { type: 'person', title: 'Hazel Example', compiled_truth: 'Fictional.', timeline: '', frontmatter: {} }, { sourceId });
    return (await tx.readPageSnapshot(slug, { sourceId }))!;
  }, TEST_WRITE_ATTRIBUTION));
  const file = join(root, `${slug}.md`); mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, serializePageToMarkdown(snapshot.page, snapshot.tags));
  const ctx = context(engine, sourceId);
  const forgotten = await submitRememberMutation(ctx, { fact: 'Keeps bees followupaaaa', entity: slug, provenance: 'test', visibility: 'world' }, 30_000);
  const retained = await submitRememberMutation(ctx, { fact: 'Plays the oboe followupbbbb', entity: slug, provenance: 'test', visibility: 'world' }, 30_000);
  expect([forgotten.state, retained.state]).toEqual(['committed', 'committed']);
  // The committing process exits: nothing drains queued effects in-process.
  await disposePersistenceConsumer(engine);
  return { ctx, sourceId, slug, binding, forgottenId: String(forgotten.id), file };
}

async function admitCorrection(engine: BrainEngine, f: Awaited<ReturnType<typeof entity>>) {
  const snapshot = (await engine.readPageSnapshot(f.slug, { sourceId: f.sourceId }))!;
  const authority = await submissionAuthority(f.ctx, 'remember', f.sourceId, snapshot.sourceIncarnation, f.slug);
  const intent = { fact: 'Gave up beekeeping followupcccc', provenance: 'test', entity_slug: f.slug, visibility: 'world', fence: true,
    valid_from: new Date().toISOString(), valid_until: null };
  return admitWrite(engine, { principal: authority.principal, operation: 'remember', sourceId: f.sourceId, sourceIncarnation: snapshot.sourceIncarnation,
    slug: f.slug, pageId: snapshot.page.id, callerIntent: intent, intent, authority, requestId: randomUUID(),
    worktreeId: f.binding.worktree_id, topologyGeneration: f.binding.topology_generation });
}

async function claimAndPublish(engine: BrainEngine, f: Awaited<ReturnType<typeof entity>>, id: string) {
  const row = await claimNextWrite(engine, hostId);
  expect(row?.id).toBe(id);
  return publishMutation(engine, row!, await prepareMemoryMutation(engine, row!, f.ctx.config), hostId);
}

describe('writes after a forget whose effects stay queued, both engines', () => {
  test('a forget strikes the file before it commits, so a write to the withdrawn page commits first time', async () => {
    for (const engine of engines) {
      const f = await entity(engine);
      expect(await submitForgetMutation(f.ctx, 'forget', { id: f.forgottenId, reason: 'test' })).toMatchObject({ state: 'committed' });
      await disposePersistenceConsumer(engine);
      const struck = readFileSync(f.file, 'utf8');
      expect(struck).toContain('~~Keeps bees followupaaaa~~');
      expect(struck).toContain('forgotten:');
      expect(await engine.executeRaw(`SELECT 1 FROM persistence_effects WHERE source_id=$1 AND kind='withdrawal-mirror'`, [f.sourceId])).toHaveLength(0);
      const admitted = await admitCorrection(engine, f);
      expect((await claimAndPublish(engine, f, admitted.id)).state).toBe('committed');
      expect(readFileSync(f.file, 'utf8')).toContain('~~Keeps bees followupaaaa~~');
    }
  });

  test('a forget submitted while a write to the page is in flight queues behind it, and both commit first time', async () => {
    for (const engine of engines) {
      const f = await entity(engine);
      const admitted = await admitCorrection(engine, f);
      const row = (await claimNextWrite(engine, hostId))!;
      expect(row.id).toBe(admitted.id);
      const prepared = await prepareMemoryMutation(engine, row, f.ctx.config);
      const forget = { id: f.forgottenId, reason: 'test', request_id: randomUUID() };
      const pending = await submitForgetMutation(f.ctx, 'forget', forget, 200).catch((error: { writeRequest?: { state?: string } }) => error);
      expect((pending as { writeRequest?: { state?: string } }).writeRequest?.state).toBe('queued');
      const first = await publishMutation(engine, row, prepared, hostId);
      expect({ state: first.state, error: first.error_code }).toEqual({ state: 'committed', error: null });
      expect(await submitForgetMutation(f.ctx, 'forget', forget, 30_000)).toMatchObject({ state: 'committed' });
      await disposePersistenceConsumer(engine);
      const text = readFileSync(f.file, 'utf8');
      expect(text).toContain('Gave up beekeeping followupcccc');
      expect(text).toContain('~~Keeps bees followupaaaa~~');
      expect((await getWriteRequestById(engine, admitted.id))!.state).toBe('committed');
    }
  });

  test('an acknowledged forget leaves the retained facts on its page searchable', async () => {
    for (const engine of engines) {
      const f = await entity(engine);
      expect(await submitForgetMutation(f.ctx, 'forget', { id: f.forgottenId, reason: 'test' })).toMatchObject({ state: 'committed' });
      const text = (await engine.getChunks(f.slug, { sourceId: f.sourceId })).map(chunk => chunk.chunk_text).join('\n');
      expect(text).toContain('followupbbbb');
      expect(text).not.toContain('followupaaaa');
      expect((await engine.searchKeyword('followupbbbb', { sourceId: f.sourceId })).map(hit => hit.slug)).toContain(f.slug);
      expect(await engine.searchKeyword('followupaaaa', { sourceId: f.sourceId })).toEqual([]);
    }
  });
});
