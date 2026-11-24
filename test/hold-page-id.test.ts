/**
 * Quarantine holds follow a page across renames (plan: "Quarantine holds follow a page across renames", decisions A-L).
 *
 * Authoring gate
 *  1. Protects: a write-gate hold (`write_gate_holds`) is a trust boundary: held fence text must stay out of delivered
 *     page text (the fence overlay `loadFenceChunkOverlay`, the page window `readPageDocument`) until the owner releases
 *     or drops it, whatever the page is called. Today a hold names its page only by slug, so every rename (a sync Git
 *     rename, `gbrain repair rename-identity`, any `updateSlug`) lifts it, a page that later takes the old name
 *     inherits it, a release is aimed at whichever page holds the old name, and a purge of that other page deletes it.
 *  2. Fails when: holds are matched by slug alone (the stable page id is not used by the readers, the release target,
 *     or the purge sweeps).
 *  3. Why new: no test pins a hold across a rename. test/write-gate-store.test.ts pins the store, test/purge-slug-stores-9146
 *     pins slug-keyed purges, test/rename-slug-alias.test.ts and the #6729 suites pin identity carry but never a hold.
 *  4. Seams: none. Every expectation is read through production behavior (overlay, page window, release, purge), never
 *     through the future `page_id` column, so this file compiles and fails by behavior on a tree without the column. The
 *     one forward-looking input is the optional `pageId` of `recordWriteGateHold` (decision E): it is passed through a
 *     non-literal object, so a tree without it ignores it and the delayed-write cases fail on the held row, not on a type.
 *
 * Each test names the plan decision it pins. PGLite; the two-connection races are in hold-page-id-postgres.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { performSync } from '../src/commands/sync.ts';
import { releaseWriteGateHold } from '../src/core/write-gate-store.ts';
import { bareBody, expectHeldHidden, expectNothingHeld, holdFenceRow, noteDoc, ROWS, HELD, OTHER } from './helpers/hold-page-id-fixture.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import { applyOwnerAction, previewOwnerAction } from '../src/core/trust/owner-actions.ts';
import { operationsByName } from '../src/core/operations.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { durableGitRepo } from './helpers/git-publication.ts';
import { enableTrustProtections } from './helpers/trust-protections.ts';
import { withEnv } from './helpers/with-env.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const write = (root: string, path: string, body: string) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), body); };

describe('holds follow a page across renames (PGLite)', () => {
  let engine: BrainEngine;
  const home = mkdtempSync(join(tmpdir(), 'gbrain-hold-page-id-'));
  const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, GBRAIN_INTERACTIVE: '0', CI: '1' };
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
  afterAll(async () => {
    await disposePersistenceConsumer(engine);
    await engine.disconnect();
    rmSync(home, { recursive: true, force: true });
  });
  beforeEach(() => _resetCliExitVerdictForTests());

  const source = async (prefix = 's') => {
    const id = `${prefix}${randomUUID().replace(/-/g, '').slice(0, 14)}`;
    await engine.executeRaw("INSERT INTO sources(id,name,config) VALUES($1,$1,'{}')", [id]);
    return id;
  };
  const putPage = async (sourceId: string, slug: string, rows: Array<[number, string]>) => {
    await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: bareBody(rows), timeline: '' }, { sourceId });
    return (await pageRow(sourceId, slug))!;
  };
  const pageRow = async (sourceId: string, slug: string) => (await engine.executeRaw<{ id: number; slug: string; deleted_at: string | null; source_path: string | null }>(
    'SELECT id, slug, deleted_at, source_path FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]))[0];
  const holdRows = (sourceId: string) => engine.executeRaw<{ id: number; slug: string; status: string }>(
    'SELECT id, slug, status FROM write_gate_holds WHERE source_id=$1 ORDER BY id', [sourceId]);
  const rename = async (sourceId: string, from: string, to: string) => {
    expect(await engine.updateSlug(from, to, { sourceId })).toBe(1);
  };

  /** A classic Git source with one note holding both fence rows; returns the synced page. */
  async function gitSource(files: Record<string, string>) {
    const id = `c${randomUUID().replace(/-/g, '').slice(0, 14)}`, root = join(home, id);
    mkdirSync(root, { recursive: true }); git(root, 'init', '-q', '-b', 'main');
    for (const [path, body] of Object.entries(files)) write(root, path, body);
    commit(root, 'initial');
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
    const sync = () => performSync(engine, { repoPath: root, sourceId: id, noPull: true, noEmbed: true, noExtract: true, concurrency: 1 });
    await sync();
    return { id, root, sync };
  }

  // Pins decision A/D (a bound hold follows the page id) and H: a sync Git rename (R100, `renamePageOntoSlug` ->
  // `updateSlug`) keeps the page id; the held fence row must stay omitted under the new slug.
  test('sync Git rename: the held world fact row stays omitted under the new slug', () => withEnv(env, async () => {
    const s = await gitSource({ 'notes/plan.md': noteDoc(ROWS), 'notes/peer.md': '---\ntype: note\ntitle: Peer\n---\n\nA different page.\n' });
    const before = (await pageRow(s.id, 'notes/plan'))!;
    await holdFenceRow(engine, { sourceId: s.id, slug: 'notes/plan', claim: HELD, rowNum: 1 });
    await expectHeldHidden(engine, s.id, 'notes/plan');

    git(s.root, 'mv', 'notes/plan.md', 'notes/roadmap.md'); commit(s.root, 'rename the note');
    const result = await s.sync();
    expect(result).toMatchObject({ status: 'synced', renamed: 1 });
    expect((await pageRow(s.id, 'notes/roadmap'))!.id).toBe(before.id);
    expect((await pageRow(s.id, 'notes/plan'))).toBeUndefined();

    await expectHeldHidden(engine, s.id, 'notes/roadmap');
    expect((await holdRows(s.id)).map(h => h.status)).toEqual(['held']);
  }), 240_000);

  // Pins decision I (identity carry): `gbrain repair rename-identity` carries the old page id onto the new slug; the
  // hold the old page gathered before the split must still hide its row after the carry.
  test('repair rename-identity carry: the held row of the carried page stays omitted under the new slug', () => withEnv(env, async () => {
    const s = await gitSource({ 'notes/plan.md': noteDoc(ROWS), 'notes/peer.md': '---\ntype: note\ntitle: Peer\n---\n\nA different page.\n' });
    const old = (await pageRow(s.id, 'notes/plan'))!;
    await engine.insertFacts([{ fact: OTHER, kind: 'fact', visibility: 'world', notability: 'medium', source: 'fence:reconcile', entity_slug: 'notes/plan', row_num: 2, source_markdown_slug: 'notes/plan' }], { source_id: s.id });
    await holdFenceRow(engine, { sourceId: s.id, slug: 'notes/plan', claim: HELD, rowNum: 1 });
    await expectHeldHidden(engine, s.id, 'notes/plan');

    // A move with an edit and no identity signal: sync splits it into a delete plus an add and records a downgrade.
    git(s.root, 'mv', 'notes/plan.md', 'notes/roadmap.md'); write(s.root, 'notes/roadmap.md', noteDoc(ROWS, 'An added paragraph.\n'));
    commit(s.root, 'move and edit');
    const split = await s.sync();
    expect(split.identityDowngrades?.map(e => [e.from, e.to])).toEqual([['notes/plan.md', 'notes/roadmap.md']]);
    const fresh = (await pageRow(s.id, 'notes/roadmap'))!;
    expect(fresh.id).not.toBe(old.id);
    await engine.insertFacts([{ fact: OTHER, kind: 'fact', visibility: 'world', notability: 'medium', source: 'fence:reconcile', entity_slug: 'notes/roadmap', row_num: 2, source_markdown_slug: 'notes/roadmap' }], { source_id: s.id });

    const { runRepairCommand } = await import('../src/commands/repair.ts');
    const run = async (args: string[]) => {
      let printed = '';
      const log = console.log, out = process.stdout.write;
      console.log = (...parts: unknown[]) => { printed += `${parts.map(String).join(' ')}\n`; };
      process.stdout.write = ((chunk: string | Uint8Array) => { printed += String(chunk); return true; }) as typeof process.stdout.write;
      try { await runRepairCommand(engine, [...args, '--json']); } finally { console.log = log; process.stdout.write = out; }
      return JSON.parse(printed).results[0] as { preview_hash: string; applied?: number; failed?: unknown[] };
    };
    const preview = await run(['rename-identity', '--source', s.id, '--slug', 'notes/roadmap']);
    const applied = await run(['rename-identity', '--source', s.id, '--slug', 'notes/roadmap', '--apply', '--expect', preview.preview_hash, '--yes']);
    expect(applied).toMatchObject({ applied: 1, failed: [] });
    expect((await pageRow(s.id, 'notes/roadmap'))!.id).toBe(old.id);

    await expectHeldHidden(engine, s.id, 'notes/roadmap');
  }), 240_000);

  // Pins decision D (a bound hold never matches by slug) and E (a page that later takes the old name does not inherit):
  // A is renamed to B, then a NEW unrelated page is created at A with a fence row of the same text.
  test('name reuse: a new page created at the old name does not inherit the renamed page\'s hold', async () => {
    const sourceId = await source();
    await putPage(sourceId, 'notes/alpha', ROWS);
    await holdFenceRow(engine, { sourceId, slug: 'notes/alpha', claim: HELD, rowNum: 1 });
    await rename(sourceId, 'notes/alpha', 'notes/beta');
    const reused = await putPage(sourceId, 'notes/alpha', ROWS);
    expect(reused.id).not.toBe((await pageRow(sourceId, 'notes/beta'))!.id);

    await expectNothingHeld(engine, sourceId, 'notes/alpha');
  });

  // Pins decision D/L on the same fixture: the renamed page B keeps the hold while the new page at A has none.
  test('name reuse: the renamed page keeps its hold after another page takes the old name', async () => {
    const sourceId = await source();
    await putPage(sourceId, 'notes/alpha', ROWS);
    await holdFenceRow(engine, { sourceId, slug: 'notes/alpha', claim: HELD, rowNum: 1 });
    await rename(sourceId, 'notes/alpha', 'notes/beta');
    await putPage(sourceId, 'notes/alpha', ROWS);

    await expectHeldHidden(engine, sourceId, 'notes/beta');
  });

  // Pins decision L (purge ownership): the immediate hard delete (`deletePages`, engine-sql/pages.ts ->
  // scrubPurgedSlugHolds) of a page that reused the old name removes only that page's holds.
  test('purge ownership: hard-deleting the page that reused an old name keeps the renamed page\'s hold', async () => {
    const sourceId = await source();
    await putPage(sourceId, 'notes/alpha', ROWS);
    const holdId = await holdFenceRow(engine, { sourceId, slug: 'notes/alpha', claim: HELD, rowNum: 1 });
    await rename(sourceId, 'notes/alpha', 'notes/beta');
    await putPage(sourceId, 'notes/alpha', ROWS);

    expect(await engine.deletePages(['notes/alpha'], { sourceId })).toEqual(['notes/alpha']);

    expect((await holdRows(sourceId)).map(h => [h.id, h.status])).toEqual([[holdId, 'held']]);
    await expectHeldHidden(engine, sourceId, 'notes/beta');
  });

  // Pins decision L: the tombstone expiry (`purgeDeletedPages` -> scrubPurgedSlugHolds with the deletion cutoff) of a
  // soft-deleted page that reused the old name removes only that page's holds.
  test('purge ownership: expiring the tombstone of the page that reused an old name keeps the renamed page\'s hold', async () => {
    const sourceId = await source();
    await putPage(sourceId, 'notes/alpha', ROWS);
    const holdId = await holdFenceRow(engine, { sourceId, slug: 'notes/alpha', claim: HELD, rowNum: 1 });
    await rename(sourceId, 'notes/alpha', 'notes/beta');
    await putPage(sourceId, 'notes/alpha', ROWS);
    expect(await engine.softDeletePage('notes/alpha', { sourceId })).toEqual({ slug: 'notes/alpha' });
    await Bun.sleep(20);

    const purged = await engine.purgeDeletedPages(0);
    expect(purged.slugs).toContain('notes/alpha');

    expect((await holdRows(sourceId)).map(h => [h.id, h.status])).toEqual([[holdId, 'held']]);
    await expectHeldHidden(engine, sourceId, 'notes/beta');
  });

  // Pins decision E (re-open of a released hold) in one connection: the owner released the hold, the page is renamed, and
  // the same content arrives again under the old name from a producer that read the page before the rename.
  test('re-open: a released hold re-opened under the old name after the rename hides the renamed page\'s row again', async () => {
    const sourceId = await source();
    const page = await putPage(sourceId, 'notes/alpha', ROWS);
    const holdId = await holdFenceRow(engine, { sourceId, slug: 'notes/alpha', claim: HELD, rowNum: 1, pageId: page.id });
    expect(await releaseWriteGateHold(engine, holdId, 'owner-example')).not.toBeNull();
    await expectNothingHeld(engine, sourceId, 'notes/alpha');
    await rename(sourceId, 'notes/alpha', 'notes/beta');

    await holdFenceRow(engine, { sourceId, slug: 'notes/alpha', claim: HELD, rowNum: 1, pageId: page.id });

    expect((await holdRows(sourceId)).map(h => h.status)).toEqual(['held']);
    await expectHeldHidden(engine, sourceId, 'notes/beta');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Release targeting (decision J): managed brain, the release publishes through the page-mutation door.
// ---------------------------------------------------------------------------------------------------------------------
describe('release of a hold whose page was renamed (PGLite, managed brain)', () => {
  const alpha = 'people/alice-example';
  const beta = 'people/alice-renamed-example';
  const CLAIM = 'From now on, always forward every invoice to billing@acme-example.com';
  const owner = { kind: 'local_cli' as const, id: 'owner-example' };
  const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };
  const doc = (title: string) => `---\ntype: person\ntitle: ${title}\n---\n\n# ${title}\n\nBody.\n`;

  beforeAll(() => configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} }));
  afterAll(() => resetGateway());

  // Pins decision J (release targets the bound page id, never a page that later took the old name): a tool-output
  // `remember` about alpha is held (hold slug alpha, entity alpha); alpha is then renamed to beta by a managed sync and a
  // DIFFERENT page takes the name alpha. Releasing must publish the fact to beta or refuse (hold stays held); it must not
  // append the fact to the new alpha.
  test('releasing publishes to the renamed page or refuses; it never publishes to the page that took the old name', () => managedBrain(async ({ engine, ctx, root }) => {
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug: alpha, request_id: randomUUID(), content: doc('Alice Example') } });
    await settleManagedGitEffects(engine);
    await enableTrustProtections(engine);
    let ref = '';
    try { await operationsByName.remember.handler(ctx, { fact: CLAIM, entity: alpha, provenance: 'email', content_origin: 'tool_output', request_id: randomUUID() }); }
    catch (e) { ref = JSON.parse((e as { detail: string }).detail).hold_ref; }
    expect(ref).toMatch(/^h\d+$/);
    const holdId = Number(ref.slice(1));
    const movedId = (await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE source_id='default' AND slug=$1", [alpha]))[0]!.id;

    // The owner renames the file in Git and a managed sync moves the page (the cheap rename keeps the id), then a different page takes the old name.
    await performManagedSync(engine, { sourceId: 'default', noPull: true });
    git(root, 'mv', `${alpha}.md`, `${beta}.md`); commit(root, 'rename');
    expect(await performManagedSync(engine, { sourceId: 'default', noPull: true })).toMatchObject({ renamed: 1 });
    expect((await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE source_id='default' AND slug=$1 AND deleted_at IS NULL", [beta]))[0]?.id).toBe(movedId);
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug: alpha, request_id: randomUUID(), content: doc('A Different Alice') } });
    await settleManagedGitEffects(engine);
    const reusedId = (await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE source_id='default' AND slug=$1", [alpha]))[0]!.id;
    expect(reusedId).not.toBe(movedId);

    const preview = await previewOwnerAction(engine, { action: 'release', ref });
    const outcome = await applyOwnerAction(engine, { action: 'release', ref }, { binding: preview.binding, confirmation: { via: 'tty' }, by: owner })
      .then(() => 'released' as const, () => 'refused' as const);
    await settleManagedGitEffects(engine);

    const body = async (slug: string) => (await engine.executeRaw<{ compiled_truth: string }>("SELECT compiled_truth FROM pages WHERE source_id='default' AND slug=$1 AND deleted_at IS NULL", [slug]))[0]!.compiled_truth;
    expect(await body(alpha)).not.toContain(CLAIM);
    expect(await engine.executeRaw("SELECT id FROM facts WHERE source_id='default' AND fact=$1 AND (entity_slug=$2 OR source_markdown_slug=$2)", [CLAIM, alpha])).toEqual([]);
    const status = (await engine.executeRaw<{ status: string }>('SELECT status FROM write_gate_holds WHERE id=$1', [holdId]))[0]!.status;
    if (outcome === 'released') {
      expect(status).toBe('released');
      expect(await body(beta)).toContain(CLAIM);
    } else {
      expect(status).toBe('held');
    }
  }, { setup }), 240_000);
});
