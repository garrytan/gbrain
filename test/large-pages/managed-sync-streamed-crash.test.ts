/**
 * Wave B: the crash window of a managed sync that streams a page over the
 * single-string ceiling (spec 3.2, 3.3).
 *
 * 1. Protects: an owner killed between its preparation and the publication
 *    (`consumer:prepared`, SIGKILL in a child process) leaves the request
 *    running with a reference-only intent and its staging prepared; once the
 *    dead claim lapses, the next run's owner prepares the request again from
 *    its `body_ref` (re-streaming and re-verifying the file) and publishes the
 *    page byte-identical, and segment GC collects the dead staging.
 * 2. Fails when: the journal needs the body to re-prepare, the dead staging
 *    blocks the re-preparation, or GC keeps it.
 * Seams: test/fixtures/convergence-fault-kill.ts preloaded into the child (the
 * persistence gate's fault hook); no mocks.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { parseMarkdown } from '../../src/core/markdown.ts';
import { PAGE_MAX_BYTES } from '../../src/core/page-size-policy.ts';
import { BODY_STAGING_HARD_MS } from '../../src/core/page-body/limits.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { performManagedSync } from '../../src/core/persistence/sync-run.ts';
import { syncLockId } from '../../src/core/db-lock.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { withEnv } from '../helpers/with-env.ts';
import { conversationPage } from '../helpers/conversation-page.ts';
import { reconstructedPage } from '../helpers/segmented-page-checks.ts';

const REPO = resolve(import.meta.dir, '../..');
const home = mkdtempSync(join(tmpdir(), 'gbrain-sync-streamed-crash-'));
const env = { GBRAIN_HOME: home, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
const huge = conversationPage(PAGE_MAX_BYTES + 1024 * 1024, { seed: 72 });
const sourceId = `streamed-crash-${randomUUID().slice(0, 8)}`;
const brain = join(home, 'brain');
const root = join(home, sourceId);
const marker = join(home, 'fault.marker');
const CHILD = `
import { createEngine } from ${JSON.stringify(join(REPO, 'src/core/engine-factory.ts'))};
import { performManagedSync } from ${JSON.stringify(join(REPO, 'src/core/persistence/sync-run.ts'))};
const [brain, sourceId] = process.argv.slice(-2);
const engine = await createEngine({ engine: 'pglite', database_path: brain });
await engine.connect({ engine: 'pglite', database_path: brain });
for (let pass = 0; pass < 30; pass++) await performManagedSync(engine, { sourceId, noPull: true, noEmbed: true });
`;
let engine: PGLiteEngine;
let child: ReturnType<typeof spawnSync>;

function git(...args: string[]): void { execFileSync('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }); }

beforeAll(async () => withEnv(env, async () => {
  const setup = new PGLiteEngine(); await setup.connect({ database_path: brain }); await setup.initSchema();
  await setup.setConfig('pages.segmented_storage', 'on');
  mkdirSync(join(root, 'notes'), { recursive: true });
  writeFileSync(join(root, 'notes/huge.md'), huge);
  git('init', '-q'); git('add', '-A'); git('-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'huge');
  await setup.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await setup.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [sourceId, root]);
  await claimWorktree(setup, sourceId, root);
  await setup.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  await disposePersistenceConsumer(setup); await setup.disconnect();
  child = spawnSync(process.execPath, ['--no-env-file', '--preload', join(REPO, 'test/fixtures/convergence-fault-kill.ts'), '-e', CHILD, brain, sourceId],
    { cwd: REPO, encoding: 'utf8', timeout: 300_000,
      env: { ...process.env, GBRAIN_HOME: home, OPENAI_API_KEY: '', VOYAGE_API_KEY: '', ANTHROPIC_API_KEY: '',
        GBRAIN_TEST_CONVERGENCE_FAULT: JSON.stringify({ point: 'consumer:prepared', nth: 1, marker, operation: 'submit_job' }) } });
  engine = new PGLiteEngine(); await engine.connect({ database_path: brain });
}), 600_000);

afterAll(async () => {
  await withEnv(env, async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });
  rmSync(home, { recursive: true, force: true });
});

test('an owner killed between preparation and publication: the next run re-prepares from the reference and publishes', async () => withEnv(env, async () => {
  expect(child.signal).toBe('SIGKILL');
  expect(JSON.parse(readFileSync(marker, 'utf8'))).toMatchObject({ point: 'consumer:prepared', operation: 'submit_job' });
  const [running] = await engine.executeRaw<{ state: string; intent: Record<string, unknown> }>(
    "SELECT state, intent FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_sync_import'", [sourceId]);
  expect(running!.state).toBe('running');
  expect(running!.intent.content).toBeNull();
  expect(running!.intent.body_ref).toMatchObject({ kind: 'git_blob', bytes: Buffer.byteLength(huge) });
  const dead = await engine.executeRaw<{ id: string }>("SELECT id::text AS id FROM page_body_stagings WHERE source_id=$1 AND state='prepared'", [sourceId]);
  expect(dead.length).toBe(1);

  // The dead owner's claim lapses, as its lease would; the next run's owner reclaims the request and prepares it again.
  await engine.executeRaw("UPDATE persistence_requests SET claim_expires_at=now()-interval '1 second' WHERE source_id=$1 AND state='running'", [sourceId]);
  // So does its drain lease (#6712): a dead same-host holder is taken over once its lease is older than the takeover grace.
  await engine.executeRaw("UPDATE gbrain_cycle_locks SET acquired_at=now()-interval '2 minutes' WHERE id=$1 AND holder_pid=$2", [syncLockId(sourceId), child.pid]);
  let result = await performManagedSync(engine, { sourceId, noPull: true, noEmbed: true });
  for (let pass = 0; result.status === 'partial' && pass < 30; pass++) result = await performManagedSync(engine, { sourceId, noPull: true, noEmbed: true });
  expect(result.status).toBe('first_sync');
  const { page, body, hash } = await reconstructedPage(engine, 'notes/huge', sourceId);
  expect(page.body_storage).toBe('segmented');
  expect(body.compiled_truth).toBe(parseMarkdown(huge, 'notes/huge.md').compiled_truth);
  expect(page.content_hash).toBe(hash);
  expect(page.text_projection_revision).toBe(page.knowledge_revision);
  const states = await engine.executeRaw<{ state: string }>("SELECT state FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_sync_import'", [sourceId]);
  expect(states.map(row => row.state)).toEqual(['committed']);

  await engine.sweepSegments({ sourceId, expireStagings: true, now: new Date(Date.now() + BODY_STAGING_HARD_MS + 60_000) });
  expect((await engine.executeRaw<{ state: string }>('SELECT state FROM page_body_stagings WHERE id=$1::uuid', [dead[0]!.id]))[0]?.state).not.toBe('prepared');
  expect(await engine.executeRaw('SELECT 1 FROM page_body_manifest WHERE page_id=$1 AND staging_id IS NOT NULL', [page.id])).toEqual([]);
  expect((await reconstructedPage(engine, 'notes/huge', sourceId)).body).toEqual(body);
}), 600_000);
