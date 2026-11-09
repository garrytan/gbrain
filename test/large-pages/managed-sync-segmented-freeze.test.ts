/**
 * GBRA-287: a managed sync re-importing a git-tracked page stored in segments never blocks the source.
 *
 * 1. Protects: the freeze of an import whose working-tree bytes differ from the pinned commit (a live checkout) compares
 *    the stored page read back whole, as its publication does, so a segmented page up to the single-string ceiling earns
 *    exactly the outcome its inline twin earns (here the `worktree_dirty` hold) and the run completes. A page whose
 *    stored body cannot be read (segment rows that do not tile it) is held at the freeze, naming
 *    `page_body_rows_unreadable`, while the rest of the commit imports and the run completes; `gbrain sync status` classifies
 *    that hold by its page-body code. A run that does stop in its freeze phase reports `request_id: null` (none admitted).
 * 2. Fails when: the freeze reads the snapshot's throwing body getter (`rowToPage.compiled_truth`, `page_body_segmented`)
 *    and the run stops `blocked` with a recorded failure, or a page-body fault blocks the run instead of holding the page.
 * 3. PGLite.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { performManagedSync } from '../../src/core/persistence/sync-run.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { withEnv } from '../helpers/with-env.ts';
import { opError } from '../../src/core/ops/contract.ts';
import { installFaultHook } from '../../src/core/persistence/fault-points.ts';
import { readSyncStatus } from '../../src/core/persistence/sync-status.ts';
import { withManagedFixtureWrite } from '../helpers/managed-e2e-fixture-write.ts';
import { conversationBody } from '../helpers/conversation-page.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-segmented-freeze-'));
const env = { GBRAIN_HOME: home, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
let engine: PGLiteEngine;

function git(root: string, ...args: string[]): string { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function commit(root: string): void { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'test content'); }
const person = (bytes: number) => '---\ntype: person\ntitle: Person Example\n---\n\n# Person Example\n\n' + conversationBody(bytes, { seed: 7 }) + '\n<!-- timeline -->\n- **2026-10-01** | manual — first\n';

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => {
  await withEnv(env, async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });
  rmSync(home, { recursive: true, force: true });
});

async function fixture(segmented: boolean, bytes: number) {
  await disposePersistenceConsumer(engine);
  await engine.setConfig('pages.segmented_storage', segmented ? 'on' : 'off');
  const sourceId = `freeze-${randomUUID().slice(0, 8)}`;
  const root = join(home, sourceId);
  mkdirSync(join(root, 'people'), { recursive: true });
  git(root, 'init', '-q');
  writeFileSync(join(root, 'people/person-example.md'), person(bytes));
  writeFileSync(join(root, 'people/other-example.md'), '---\ntype: person\ntitle: Other Example\n---\n\nfirst\n');
  commit(root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [sourceId, root]);
  await claimWorktree(engine, sourceId, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  expect(await performManagedSync(engine, { sourceId, noPull: true })).toMatchObject({ status: 'first_sync', filesImported: 2 });
  const [row] = await engine.executeRaw<{ id: number; body_storage: string }>("SELECT id, body_storage FROM pages WHERE source_id=$1 AND slug='people/person-example'", [sourceId]);
  expect(row!.body_storage).toBe(segmented ? 'segmented' : 'inline');
  return { sourceId, root, pageId: Number(row!.id) };
}

/** A committed edit plus uncommitted bytes past it: the freeze compares the working tree with the stored page. */
async function liveCheckoutSync(segmented: boolean, bytes: number) {
  const f = await fixture(segmented, bytes);
  appendFileSync(join(f.root, 'people/person-example.md'), '- **2026-11-02** | meeting — second\n');
  commit(f.root);
  appendFileSync(join(f.root, 'people/person-example.md'), '- **2026-11-03** | meeting — third, not yet committed\n');
  return performManagedSync(engine, { sourceId: f.sourceId, noPull: true, noEmbed: true, noExtract: true });
}

test('a live checkout re-import of a 1.26 MiB segmented page completes with the outcome its inline twin gets', async () => withEnv(env, async () => {
  const inline = await liveCheckoutSync(false, 64 * 1024);
  const segmented = await liveCheckoutSync(true, 1260 * 1024);
  expect(inline.status).toBe('synced');
  expect(segmented.status).toBe('synced');
  expect(segmented.failures).toBeUndefined();
  expect((segmented.held ?? []).map(hold => [hold.path, hold.code])).toEqual((inline.held ?? []).map(hold => [hold.path, hold.code]));
  expect((segmented.held ?? []).map(hold => hold.code)).toEqual(['worktree_dirty']);
}), 300_000);

test('a segmented page whose rows do not tile its body is held at the freeze; the rest of the commit imports', async () => withEnv(env, async () => {
  const f = await fixture(true, 1260 * 1024);
  await withManagedFixtureWrite(engine, [f.sourceId], tx => tx.executeRaw('DELETE FROM page_body_manifest WHERE page_id=$1 AND staging_id IS NULL AND seq=(SELECT max(seq) FROM page_body_manifest WHERE page_id=$1 AND staging_id IS NULL)', [f.pageId]));
  appendFileSync(join(f.root, 'people/person-example.md'), '- **2026-11-02** | meeting — second\n');
  writeFileSync(join(f.root, 'people/other-example.md'), '---\ntype: person\ntitle: Other Example\n---\n\nsecond\n');
  commit(f.root);
  const result = await performManagedSync(engine, { sourceId: f.sourceId, noPull: true, noEmbed: true, noExtract: true });
  expect(result.status).toBe('synced');
  expect(result.failures).toBeUndefined();
  expect((result.held ?? []).map(hold => [hold.path, hold.code])).toEqual([['people/person-example.md', 'page_write_failed']]);
  expect(result.held![0]!.message).toContain('page_body_rows_unreadable');
  expect((await readSyncStatus(engine, f.sourceId, { detail: false })).holds).toEqual([expect.objectContaining({ code: 'page_write_failed',
    path: 'people/person-example.md', needs_human: true, safe_actions: ['repair'] })]);
  const [other] = await engine.executeRaw<{ compiled_truth: string }>("SELECT compiled_truth FROM pages WHERE source_id=$1 AND slug='people/other-example'", [f.sourceId]);
  expect(other!.compiled_truth).toContain('second');
  expect(await engine.executeRaw('SELECT last_commit FROM sources WHERE id=$1', [f.sourceId])).toEqual([{ last_commit: git(f.root, 'rev-parse', 'HEAD') }]);
}), 300_000);

test('a run stopped in its freeze phase, before any request is admitted, says so in sync status (request_id null)', async () => withEnv(env, async () => {
  const f = await fixture(false, 4 * 1024);
  writeFileSync(join(f.root, 'people/other-example.md'), '---\ntype: person\ntitle: Other Example\n---\n\nsecond\n');
  commit(f.root);
  installFaultHook(point => { if (point === 'sync:after_freeze') throw opError('plan_stale', 'synthetic deliberate refusal', 'none'); });
  try {
    await expect(performManagedSync(engine, { sourceId: f.sourceId, noPull: true, noEmbed: true, noExtract: true })).rejects.toThrow('request=<not-admitted>');
  } finally { installFaultHook(undefined); }
  const { last_error } = await readSyncStatus(engine, f.sourceId, { detail: false });
  expect(last_error).toMatchObject({ code: 'plan_stale', phase: 'freeze', path: 'people/other-example.md', request_id: null });
  expect(last_error!.root_cause).toBeUndefined();
}), 300_000);
