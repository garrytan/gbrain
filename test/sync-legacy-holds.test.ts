/**
 * #5988 Lane 2: legacy (unmanaged) sync holds. A file gbrain refuses for its
 * content is held instead of failing the run: its skip carries the hold code,
 * it stays out of the failure ledger and the auto-skip streak, the bookmark
 * advances, and the hold is visible in the result until the file changes, is
 * deleted, or a retry re-screens it. A rename onto a broken file keeps the old
 * page whole and moves it (same id) once the file is fixed. `sync.holds=fail`
 * restores fail-closed blocking; a dry run lists would-be holds and writes nothing.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { performSync, printSyncResult, type SyncResult } from '../src/commands/sync.ts';
import { importFile } from '../src/core/import-file.ts';
import { loadSyncFailures, recordFailures } from '../src/core/sync-failure-ledger.ts';
import { readGitHoldRetryPaths, readGitSourceHolds, requestGitHoldRetry, syncHoldJsonFields } from '../src/core/persistence/sync-holds.ts';
import { makeGitFixture } from './helpers/git-fixture.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
let engine: BrainEngine;
const home = mkdtempSync(join(tmpdir(), 'gbrain-legacy-holds-'));
const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
const BROKEN = '---\ntitle: alice-example first line\nalice-example second line\n---\nA synthetic post.\n';
const good = (title: string) => `---\ntitle: ${title}\n---\nA synthetic note about ${title}.\n`;

beforeAll(async () => {
  if (backends.includes('pglite')) {
    const pglite = new PGLiteEngine(); await pglite.connect({}); await pglite.initSchema(); engines.push(pglite);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close;
  }
  for (const each of engines) await each.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
}, 120_000);

afterAll(async () => {
  for (const each of engines) if (each.kind === 'pglite') await each.disconnect();
  await closePostgres?.(); rmSync(home, { recursive: true, force: true });
});

/** Runs a case once per backend; the helpers below use the current `engine`. */
const eachEngine = (fn: () => Promise<void>) => withEnv(env, async () => {
  for (const each of engines) { engine = each; await fn(); }
});

async function source(files: Record<string, string>): Promise<{ id: string; root: string }> {
  const id = `lh-${randomUUID().replace(/-/g, '').slice(0, 16)}`, root = join(home, id);
  mkdirSync(join(root, 'notes'), { recursive: true }); await makeGitFixture(root);
  write(root, files);
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
  return { id, root };
}

function write(root: string, files: Record<string, string | null>, message = 'fixture content'): void {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) unlinkSync(join(root, path)); else writeFileSync(join(root, path), content);
  }
  git(root, 'add', '-A'); git(root, 'commit', '-qm', message);
}

// concurrency 1: parallel full-sync workers would connect to the configured database, not this isolated one.
const sync = (id: string, root: string, extra: Record<string, unknown> = {}) =>
  performSync(engine, { repoPath: root, sourceId: id, noPull: true, noEmbed: true, noExtract: true, concurrency: 1, ...extra });
const holds = async (id: string) => (await readGitSourceHolds(engine, { sourceIds: [id] }))[0]?.holds ?? [];
const lastCommit = async (id: string) => (await engine.executeRaw<{ last_commit: string | null }>('SELECT last_commit FROM sources WHERE id=$1', [id]))[0]?.last_commit;
const holdRows = () => engine.executeRaw("SELECT op, fingerprint, completed_keys::text AS keys, updated_at::text AS at FROM op_checkpoints WHERE op LIKE 'sync-hold%' ORDER BY op, fingerprint");
const page = async (id: string, slug: string) => (await engine.executeRaw<{ id: number; slug: string; source_path: string | null; deleted_at: string | null }>(
  'SELECT id, slug, source_path, deleted_at::text AS deleted_at FROM pages WHERE source_id=$1 AND slug=$2', [id, slug]))[0];
const printed = (result: SyncResult) => {
  let output = '';
  printSyncResult(result, { write: (text: string) => { output += text; return true; } } as NodeJS.WriteStream);
  return output;
};

test('a refused file imports as skip_reason equal to its hold code', () => eachEngine(async () => {
  const dir = mkdtempSync(join(home, 'skip-'));
  writeFileSync(join(dir, 'broken.md'), BROKEN);
  const result = await importFile(engine, join(dir, 'broken.md'), 'broken.md', { noEmbed: true });
  expect(result).toMatchObject({ status: 'skipped', skip_reason: 'invalid_frontmatter', refusal: { code: 'invalid_frontmatter', reason: 'needs_interpretation', key: 'title', line: 2 } });
}), 60_000);

test('first sync holds the refused file, advances the bookmark, resolves its ledger row and reports the hold', () => eachEngine(async () => {
  const { id, root } = await source({ 'notes/a.md': good('Alpha'), 'notes/b.md': good('Beta'), 'notes/broken.md': BROKEN });
  recordFailures(id, [{ path: 'notes/broken.md', error: 'Invalid YAML frontmatter: older run' }], 'c0');
  recordFailures(id, [{ path: 'notes/broken.md', error: 'Invalid YAML frontmatter: older run' }], 'c1');
  const result = await sync(id, root);
  expect(result.status).toBe('first_sync');
  expect(await lastCommit(id)).toBe(git(root, 'rev-parse', 'HEAD'));
  expect(await page(id, 'notes/a')).toBeDefined();
  expect(loadSyncFailures().filter(row => row.source_id === id)).toEqual([]);
  const [hold] = await holds(id);
  expect(hold).toMatchObject({ path: 'notes/broken.md', code: 'invalid_frontmatter', mode: 'legacy', page_id: null,
    meta: { reason: 'needs_interpretation', key: 'title', line: 2 } });
  expect(hold.upstream_version).toMatch(/^[0-9a-f]{64}$/);
  expect(result).toMatchObject({ held_count: 1, holds_outstanding: 1, held: [{ path: 'notes/broken.md', code: 'invalid_frontmatter', reason: 'needs_interpretation',
    docs: 'docs/guides/write-refusals.md#invalid_frontmatter-needs_interpretation', fix: { argv: ['gbrain', 'repair', 'frontmatter', '--source', id, '--include-ambiguous'] } }] });
  expect(syncHoldJsonFields(result)).toMatchObject({ held_count: 1, holds_outstanding: 1 });
  const output = printed(result);
  expect(output).toContain('Held notes/broken.md: invalid_frontmatter (needs_interpretation)');
  expect(output).not.toContain('alice-example');

  // Unchanged on the next runs: never counted toward the auto-skip streak, and no ledger row returns.
  write(root, { 'notes/c.md': good('Gamma') });
  const next = await sync(id, root);
  expect(next).toMatchObject({ status: 'synced', held_count: 0, holds_outstanding: 1 });
  expect(next.held).toEqual([]);
  expect(loadSyncFailures().filter(row => row.source_id === id)).toEqual([]);
}), 120_000);

test('incremental: a refused commit is held, fixing it imports and clears the hold, deleting a held file clears it', () => eachEngine(async () => {
  const { id, root } = await source({ 'notes/a.md': good('Alpha') });
  await sync(id, root);
  write(root, { 'notes/post.md': BROKEN, 'notes/gone.md': BROKEN, 'notes/b.md': good('Beta') });
  const held = await sync(id, root);
  expect(held).toMatchObject({ status: 'synced', held_count: 2 });
  expect(held.failedFiles).toBeUndefined();
  expect(await lastCommit(id)).toBe(git(root, 'rev-parse', 'HEAD'));
  expect((await holds(id)).map(h => h.path).sort()).toEqual(['notes/gone.md', 'notes/post.md']);

  write(root, { 'notes/post.md': good('Post'), 'notes/gone.md': null });
  const fixed = await sync(id, root);
  expect(fixed.status).toBe('synced');
  expect(await page(id, 'notes/post')).toMatchObject({ source_path: 'notes/post.md', deleted_at: null });
  expect(await holds(id)).toEqual([]);
  expect(fixed.holds_outstanding).toBeUndefined();
}), 120_000);

test('slug conflicts and over-size files are held, and a slug conflict re-screens every run', () => eachEngine(async () => {
  const { id, root } = await source({ 'notes/a.md': good('Alpha') });
  await sync(id, root);
  write(root, { 'notes/spoof.md': '---\ntitle: Spoof\nslug: notes/a\n---\nBody.\n', 'notes/huge.md': `---\ntitle: Huge\n---\n${'x'.repeat(5_100_000)}\n` });
  const result = await sync(id, root);
  expect(result.status).toBe('synced');
  expect(await lastCommit(id)).toBe(git(root, 'rev-parse', 'HEAD'));
  const byPath = Object.fromEntries((await holds(id)).map(h => [h.path, h]));
  expect(byPath['notes/spoof.md']).toMatchObject({ code: 'frontmatter_slug_conflict', meta: { key: 'slug' } });
  expect(byPath['notes/spoof.md'].message).not.toContain('notes/a"');
  expect(byPath['notes/huge.md']).toMatchObject({ code: 'file_too_large', upstream_version: null });
  expect(result.held!.find(h => h.path === 'notes/huge.md')!.fix.why).toContain('size limit is fixed');

  const before = byPath['notes/spoof.md'].observed_at;
  const again = await sync(id, root);
  expect(again.status).toBe('up_to_date');
  const after = Object.fromEntries((await holds(id)).map(h => [h.path, h]));
  expect(after['notes/spoof.md'].observed_at > before).toBe(true);
  expect(after['notes/spoof.md'].held_at).toBe(byPath['notes/spoof.md'].held_at);
}), 120_000);

test('a rename onto a broken file keeps the old page through a full sync and moves it with its id once fixed', () => eachEngine(async () => {
  const body = Array.from({ length: 30 }, (_, i) => `Line ${i} of a synthetic note that keeps the rename detectable.`).join('\n');
  const { id, root } = await source({ 'notes/old.md': `---\ntitle: Old\n---\n${body}\n` });
  await sync(id, root);
  const original = await page(id, 'notes/old');
  git(root, 'mv', 'notes/old.md', 'notes/new.md');
  write(root, { 'notes/new.md': `---\ntitle: alice-example first line\nalice-example second line\n---\n${body}\n` }, 'rename and break');
  const renamed = await sync(id, root);
  expect(renamed.status).toBe('synced');
  expect(await page(id, 'notes/old')).toMatchObject({ id: original.id, source_path: 'notes/old.md', deleted_at: null });
  expect(await page(id, 'notes/new')).toBeUndefined();
  const [hold] = await holds(id);
  expect(hold).toMatchObject({ path: 'notes/new.md', page_id: original.id, meta: { rename_from: { sourcePath: 'notes/old.md', slug: 'notes/old', pageId: original.id } } });

  const full = await sync(id, root, { full: true });
  expect(full.status).toBe('first_sync');
  expect(await page(id, 'notes/old')).toMatchObject({ id: original.id, deleted_at: null });
  expect((await holds(id))[0]?.meta.rename_from?.pageId).toBe(original.id);

  write(root, { 'notes/new.md': `---\ntitle: New\n---\n${body}\n` }, 'fix the renamed file');
  await sync(id, root);
  expect(await page(id, 'notes/new')).toMatchObject({ id: original.id, source_path: 'notes/new.md', deleted_at: null });
  expect(await page(id, 'notes/old')).toBeUndefined();
  expect(await holds(id)).toEqual([]);
}), 120_000);

test('a held rename carries its origin across a chained rename, and an edited old page holds as rename_held', async () => eachEngine(async () => {
  const body = Array.from({ length: 30 }, (_, i) => `Line ${i} of a synthetic note that keeps the rename detectable.`).join('\n');
  const broken = `---\ntitle: alice-example first line\nalice-example second line\n---\n${body}\n`;
  const { id, root } = await source({ 'notes/a.md': `---\ntitle: A\n---\n${body}\n`, 'notes/x.md': `---\ntitle: X\n---\n${body}\n` });
  await sync(id, root);
  const a = await page(id, 'notes/a'), x = await page(id, 'notes/x');
  git(root, 'mv', 'notes/a.md', 'notes/b.md'); git(root, 'mv', 'notes/x.md', 'notes/y.md');
  write(root, { 'notes/b.md': broken, 'notes/y.md': broken }, 'rename both onto broken files');
  await sync(id, root);
  expect((await holds(id)).map(h => h.path).sort()).toEqual(['notes/b.md', 'notes/y.md']);

  git(root, 'mv', 'notes/b.md', 'notes/c.md');
  write(root, { 'notes/c.md': `---\ntitle: C\n---\n${body}\n` }, 'rename the held file again, fixed');
  await sync(id, root);
  expect(await page(id, 'notes/c')).toMatchObject({ id: a.id, source_path: 'notes/c.md', deleted_at: null });
  expect((await holds(id)).map(h => h.path)).toEqual(['notes/y.md']);

  await engine.executeRaw('UPDATE pages SET knowledge_revision=gen_random_uuid() WHERE id=$1', [x.id]);
  write(root, { 'notes/y.md': `---\ntitle: Y\n---\n${body}\n` }, 'fix y after the old page changed');
  const result = await sync(id, root);
  expect(result.held).toMatchObject([{ path: 'notes/y.md', code: 'rename_held', reason: 'rename_source_changed', stale: true }]);
  expect(await page(id, 'notes/x')).toMatchObject({ id: x.id, source_path: 'notes/x.md', deleted_at: null });
  expect(await page(id, 'notes/y')).toBeUndefined();
}), 120_000);

test('a full sync holds a renamed file whose old page changed instead of importing it as a new page', async () => eachEngine(async () => {
  const body = Array.from({ length: 30 }, (_, i) => `Line ${i} of a synthetic note that keeps the rename detectable.`).join('\n');
  const { id, root } = await source({ 'notes/x.md': `---\ntitle: X\n---\n${body}\n` });
  await sync(id, root);
  const x = await page(id, 'notes/x');
  git(root, 'mv', 'notes/x.md', 'notes/y.md');
  write(root, { 'notes/y.md': `---\ntitle: alice-example first line\nalice-example second line\n---\n${body}\n` }, 'rename onto a broken file');
  await sync(id, root);
  await engine.executeRaw('UPDATE pages SET knowledge_revision=gen_random_uuid() WHERE id=$1', [x.id]);
  write(root, { 'notes/y.md': `---\ntitle: Y\n---\n${body}\n` }, 'fix y after the old page changed');

  const full = await sync(id, root, { full: true });
  expect(full.held).toMatchObject([{ path: 'notes/y.md', code: 'rename_held', reason: 'rename_source_changed', stale: true }]);
  expect(await page(id, 'notes/y')).toBeUndefined();
  expect(await page(id, 'notes/x')).toMatchObject({ id: x.id, source_path: 'notes/x.md', deleted_at: null });
  const [hold] = await holds(id);
  expect(hold).toMatchObject({ path: 'notes/y.md', code: 'rename_held', page_id: x.id, meta: { rename_from: { sourcePath: 'notes/x.md', pageId: x.id } } });
  expect(hold.message).not.toContain('alice-example');

  // Unchanged on the next full walk: still held, still no second page.
  await sync(id, root, { full: true });
  expect(await page(id, 'notes/y')).toBeUndefined();
  expect((await holds(id)).map(h => [h.path, h.code])).toEqual([['notes/y.md', 'rename_held']]);
}), 120_000);

test('a retry request or an older reader version re-screens a held file the delta did not touch', () => eachEngine(async () => {
  const { id, root } = await source({ 'notes/a.md': good('Alpha'), 'notes/broken.md': BROKEN });
  await sync(id, root);
  const [first] = await holds(id);
  await requestGitHoldRetry(engine, id, first.incarnation, ['notes/broken.md']);
  const retried = await sync(id, root);
  expect(retried).toMatchObject({ status: 'up_to_date', held_count: 1 });
  expect(await readGitHoldRetryPaths(engine, id, first.incarnation)).toEqual([]);
  const [second] = await holds(id);
  expect(second.observed_at > first.observed_at).toBe(true);
  expect(second.held_at).toBe(first.held_at);

  await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,meta,recovery_version}','0'::jsonb) WHERE op='sync-hold'
    AND completed_keys->0->>'source_id'=$1`, [id]);
  await sync(id, root);
  const [third] = await holds(id);
  expect(third.meta.recovery_version).toBeGreaterThan(0);
  expect(third.observed_at > second.observed_at).toBe(true);

  // A plain no-change run leaves an unchanged hold alone.
  await sync(id, root);
  expect((await holds(id))[0].observed_at).toBe(third.observed_at);
}), 120_000);

test('sync.holds=fail blocks on a content refusal as before and writes no hold', () => eachEngine(async () => {
  const { id, root } = await source({ 'notes/a.md': good('Alpha') });
  await sync(id, root);
  const before = await lastCommit(id);
  await engine.setConfig('sync.holds', 'fail');
  try {
    write(root, { 'notes/broken.md': BROKEN });
    const result = await sync(id, root);
    expect(result).toMatchObject({ status: 'blocked_by_failures', failedFiles: 1 });
    expect(await lastCommit(id)).toBe(before);
    expect(await holds(id)).toEqual([]);
    expect(loadSyncFailures().filter(row => row.source_id === id).map(row => row.path)).toEqual(['notes/broken.md']);
  } finally {
    await engine.setConfig('sync.holds', 'hold');
  }
}), 120_000);

test('a dry run lists would-be holds and leaves hold rows, bookmark and pages untouched', () => eachEngine(async () => {
  const { id, root } = await source({ 'notes/a.md': good('Alpha'), 'notes/held.md': BROKEN });
  await sync(id, root);
  write(root, { 'notes/new-broken.md': BROKEN, 'notes/b.md': good('Beta') });
  const rows = await holdRows();
  const bookmark = await lastCommit(id);
  const result = await sync(id, root, { dryRun: true });
  expect(result).toMatchObject({ status: 'dry_run', dry_run: true, would_hold_count: 1,
    would_hold: [{ path: 'notes/new-broken.md', code: 'invalid_frontmatter', reason: 'needs_interpretation' }], holds_outstanding: 1 });
  expect(printed(result)).toContain('Would hold notes/new-broken.md: invalid_frontmatter');
  expect(await holdRows()).toEqual(rows);
  expect(await lastCommit(id)).toBe(bookmark);
  expect(await page(id, 'notes/b')).toBeUndefined();
}), 120_000);

test('quote-recovered frontmatter imports and is counted with the generator prefix', () => eachEngine(async () => {
  const author = 'PYMNTS (citing Reuters / Bloomberg) (original: https://x.com/a/status/1)';
  const { id, root } = await source({ 'notes/a.md': good('Alpha') });
  await sync(id, root);
  mkdirSync(join(root, 'notes/feed'), { recursive: true });
  write(root, { 'notes/feed/one.md': `---\ntitle: One\nauthor: ${author}\n---\nBody.\n`, 'notes/feed/two.md': `---\ntitle: Two\nauthor: ${author}\n---\nBody.\n` });
  const result = await sync(id, root);
  expect(result.recovered_frontmatter).toMatchObject({ count: 2, common_prefix: 'notes/feed', fix: { argv: ['gbrain', 'repair', 'frontmatter', '--source', id] } });
  expect(await holds(id)).toEqual([]);
}), 120_000);

test('escalation fires past the configured hold count', () => eachEngine(async () => {
  await engine.setConfig('sync.hold_escalate_count', '0');
  try {
    const { id, root } = await source({ 'notes/a.md': good('Alpha'), 'notes/broken.md': BROKEN });
    const result = await sync(id, root);
    expect(result).toMatchObject({ holds_escalated: true, held_count: 1 });
    expect(printed(result)).toContain('HOLDS ESCALATED');
  } finally {
    await engine.setConfig('sync.hold_escalate_count', '50');
  }
}), 120_000);

test('#6188 (T5): legacy sync imports a page with a malformed fence as before and never holds it', async () => eachEngine(async () => {
  const fence = '<!--- gbrain:takes:begin -->\n| # | claim | kind | who | weight | since | source |\n|---|---|---|---|---|---|---|\n'
    + '| 1 | Synthetic take | take | brain | 0.7 | 2026-01 | chat |\n| 2 | Another take | sentinelkindzq7 | brain | 0.5 | 2026-01 | chat |\n<!--- gbrain:takes:end -->\n';
  const { id, root } = await source({ 'notes/fenced.md': `---\ntitle: Fenced\n---\nA synthetic page.\n\n${fence}`, 'notes/ok.md': good('Ok') });
  const result = await sync(id, root);
  expect(result.status).toBe('first_sync');
  expect(await holds(id)).toEqual([]);
  expect(result.held_count ?? 0).toBe(0);
  // Stored as written: the legacy path never refuses or rewrites a fence.
  expect((await engine.getPage('notes/fenced', { sourceId: id }))?.compiled_truth).toContain('| 2 | Another take | sentinelkindzq7 |');
}));

test('#6188 (T5): legacy sync stores a fixable fence normalized (the file is untouched) and reports a residual one as fence_issues', async () => eachEngine(async () => {
  const facts = '<!--- gbrain:facts:begin -->\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|---|---|---|---|---|---|---|---|---|\n'
    + '| 1 | Sentinellegacyzq8 claim | partnership | 1.0 | private | medium | 2026-01-01 |  | chat |  |\n<!--- gbrain:facts:end -->\n';
  const residual = '<!--- gbrain:takes:begin -->\n| # | claim | kind | who | weight | since | source |\n|---|---|---|---|---|---|---|\n'
    + '| 1 | Synthetic take | sentinelkindzq7 | brain | 0.5 | 2026-01 | chat |\n<!--- gbrain:takes:end -->\n';
  const fixableFile = `---\ntitle: Fixable\n---\nA synthetic page.\n\n${facts}`;
  const { id, root } = await source({ 'notes/fixable.md': fixableFile, 'notes/residual.md': `---\ntitle: Residual\n---\nA synthetic page.\n\n${residual}`, 'notes/ok.md': good('Ok') });
  const result = await sync(id, root);
  expect(result.status).toBe('first_sync');
  expect(await holds(id)).toEqual([]);
  expect(result.fences_normalized).toMatchObject({ count: 1, by_class: { kind_map: 1 }, sample_paths: ['notes/fixable.md'] });
  expect(result.fence_issues).toMatchObject({ files: 1, sample: [{ path: 'notes/residual.md', fence_issues: [{ fence: 'takes', row: 1, column: 'kind', class: 'takes_kind_unsupported' }] }] });
  expect((await engine.getPage('notes/fixable', { sourceId: id }))?.compiled_truth).toContain('| fact |');
  expect(execFileSync('cat', [join(root, 'notes/fixable.md')], { encoding: 'utf8' })).toBe(fixableFile);
  const out = JSON.stringify(syncHoldJsonFields(result)) + printed(result);
  for (const secret of ['Sentinellegacyzq8', 'partnership', 'sentinelkindzq7']) expect(out).not.toContain(secret);
}));
