/**
 * Managed-path lifecycle regressions found by the gbrain-evals lifecycle
 * experiment: slug collisions, renames (identity, inbound links, old-slug
 * aliases), link extraction on the managed write path, and `extract --stale`
 * on a managed brain. Runs on PGLite, and on Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { runManagedStaleExtraction } from '../src/core/persistence/links-maintenance.ts';
import { runExtract } from '../src/commands/extract.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { LINK_EXTRACTOR_VERSION_TS } from '../src/core/link-extraction.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-managed-lifecycle-'));
const engines: BrainEngine[] = [];
const sources: string[] = [];
let closePostgres: (() => Promise<void>) | undefined;
function git(root: string, ...args: string[]): string { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function commit(root: string, message = 'test content'): string {
  git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message);
  return git(root, 'rev-parse', 'HEAD');
}
function write(root: string, path: string, body: string) { const full = join(root, path); mkdirSync(join(full, '..'), { recursive: true }); writeFileSync(full, body); }
async function fixture(engine: BrainEngine, files: Record<string, string>) {
  const id = `life-${randomUUID().replace(/-/g, '').slice(0, 20)}`; sources.push(id);
  const root = join(home, id); mkdirSync(root); git(root, 'init', '-q');
  for (const [path, body] of Object.entries(files)) write(root, path, body);
  const head = commit(root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return { id, root, head };
}
const person = (title: string) => `---\ntitle: ${title}\ntype: person\n---\n${title} is a fictional person.\n`;
const note = (title: string, body: string, extra = '') => `---\ntitle: ${title}\n${extra}---\n${body}\n`;
async function backlinkSources(engine: BrainEngine, slug: string, sourceId: string) {
  return (await engine.getBacklinks(slug, { sourceId })).map(link => link.from_slug).sort();
}
async function pageId(engine: BrainEngine, slug: string, sourceId: string) {
  const [row] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [sourceId, slug]);
  return row?.id ?? null;
}

beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);
afterAll(async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      await disposePersistenceConsumer(engine); await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      for (const id of sources) { await engine.executeRaw('DELETE FROM oauth_clients WHERE source_id=$1', [id]); await engine.executeRaw('DELETE FROM sources WHERE id=$1', [id]); }
      await engine.disconnect();
    }
  });
  await closePostgres?.();
  rmSync(home, { recursive: true, force: true });
});

test('two files mapping to one slug skip the loser instead of blocking the whole sync', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const engine of engines) {
    const f = await fixture(engine, {
      'notes/Foo Bar.md': note('Foo Bar spaced', 'Apples and orchards.'),
      'notes/foo-bar.md': note('foo-bar dashed', 'Oranges and groves.'),
      'notes/zz-bystander.md': note('Bystander', 'An ordinary note that sorts after the pair.'),
    });
    const first = await performManagedSync(engine, { sourceId: f.id, noPull: true });
    expect(first).toMatchObject({ status: 'first_sync', added: 2 });
    expect(first.slugCollisions).toEqual([{ slug: 'notes/foo-bar', kept: 'notes/foo-bar.md', skipped: ['notes/Foo Bar.md'] }]);
    const kept = await engine.getPage('notes/foo-bar', { sourceId: f.id });
    expect(kept?.source_path).toBe('notes/foo-bar.md');
    expect(kept?.compiled_truth).toContain('Oranges');
    expect(await engine.getPage('notes/zz-bystander', { sourceId: f.id })).not.toBeNull();
    const [source] = await engine.executeRaw<{ last_commit: string }>('SELECT last_commit FROM sources WHERE id=$1', [f.id]);
    expect(source.last_commit).toBe(f.head);
    // A full re-import reports the same collision and still succeeds.
    const full = await performManagedSync(engine, { sourceId: f.id, noPull: true, full: true });
    expect(['synced', 'up_to_date']).toContain(full.status);
    expect(full.slugCollisions).toEqual([{ slug: 'notes/foo-bar', kept: 'notes/foo-bar.md', skipped: ['notes/Foo Bar.md'] }]);
    expect(await engine.executeRaw("SELECT id FROM persistence_requests WHERE source_id=$1 AND state<>'committed'", [f.id])).toEqual([]);
  }
}), 180_000);

test('a live page keeps its slug when a later file maps onto it', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const engine of engines) {
    const f = await fixture(engine, { 'notes/Foo Bar.md': note('Foo Bar spaced', 'Apples and orchards.') });
    await performManagedSync(engine, { sourceId: f.id, noPull: true });
    const owner = await pageId(engine, 'notes/foo-bar', f.id);
    write(f.root, 'notes/foo-bar.md', note('foo-bar dashed', 'Oranges and groves.'));
    write(f.root, 'notes/other.md', note('Other', 'Unrelated content.'));
    commit(f.root, 'colliding file');
    const next = await performManagedSync(engine, { sourceId: f.id, noPull: true });
    expect(next).toMatchObject({ status: 'synced', added: 1 });
    expect(next.slugCollisions).toEqual([{ slug: 'notes/foo-bar', kept: 'notes/Foo Bar.md', skipped: ['notes/foo-bar.md'] }]);
    expect(await pageId(engine, 'notes/foo-bar', f.id)).toBe(owner);
    expect((await engine.getPage('notes/foo-bar', { sourceId: f.id }))?.compiled_truth).toContain('Apples');
    expect(await engine.getPage('notes/other', { sourceId: f.id })).not.toBeNull();
  }
}), 180_000);

test('a file that replaces its vanished origin at the same slug takes over the page', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const engine of engines) {
    const f = await fixture(engine, { 'notes/Foo Bar.md': note('Foo Bar', 'Apples and orchards.') });
    await performManagedSync(engine, { sourceId: f.id, noPull: true });
    const id = await pageId(engine, 'notes/foo-bar', f.id);
    git(f.root, 'mv', 'notes/Foo Bar.md', 'notes/foo-bar.md');
    commit(f.root, 'respell');
    const next = await performManagedSync(engine, { sourceId: f.id, noPull: true });
    expect(next).toMatchObject({ status: 'synced', renamed: 1, deleted: 0 });
    expect(await pageId(engine, 'notes/foo-bar', f.id)).toBe(id);
    expect((await engine.getPage('notes/foo-bar', { sourceId: f.id }))?.source_path).toBe('notes/foo-bar.md');
    expect((await performManagedSync(engine, { sourceId: f.id, noPull: true, full: true })).slugCollisions).toBeUndefined();
    // A case-only respelling whose old file this sync removes is the same page, not an ambiguous alias.
    git(f.root, 'mv', 'notes/foo-bar.md', 'notes/Foo-Bar.md');
    commit(f.root, 'case-only respelling');
    expect(await performManagedSync(engine, { sourceId: f.id, noPull: true })).toMatchObject({ status: 'synced', renamed: 1, deleted: 0 });
    expect(await pageId(engine, 'notes/foo-bar', f.id)).toBe(id);
    expect((await engine.getPage('notes/foo-bar', { sourceId: f.id }))?.source_path).toBe('notes/Foo-Bar.md');
  }
}), 180_000);

test('two new files whose paths differ only by case are refused rather than guessed', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const engine of engines) {
    const f = await fixture(engine, { 'notes/Case.md': note('Upper', 'Upper case spelling.'), 'notes/case.md': note('Lower', 'Lower case spelling.') });
    await expect(performManagedSync(engine, { sourceId: f.id, noPull: true })).rejects.toMatchObject({ code: 'page_identity_changed' });
    expect(await engine.getPage('notes/case', { sourceId: f.id })).toBeNull();
  }
}), 180_000);

test('a renamed page keeps its id, inbound links and old slug; a moved file keeps its old slug', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const engine of engines) {
    const f = await fixture(engine, {
      'people/erin-example.md': person('Erin Example'),
      'people/carol-example.md': person('Carol Example'),
      'notes/b.md': note('Note B', 'Saw [[people/erin-example]] today.'),
      'inbox/standup.md': note('Weekly standup', 'Standup notes. [[people/carol-example]] presented.', 'id: lc-standup-0001\n'),
    });
    await performManagedSync(engine, { sourceId: f.id, noPull: true });
    const erin = await pageId(engine, 'people/erin-example', f.id);
    const standup = await pageId(engine, 'inbox/standup', f.id);
    expect(await backlinkSources(engine, 'people/erin-example', f.id)).toEqual(['notes/b']);
    mkdirSync(join(f.root, 'meetings'));
    git(f.root, 'mv', 'people/erin-example.md', 'people/erin-example-2.md');
    git(f.root, 'mv', 'inbox/standup.md', 'meetings/standup.md');
    commit(f.root, 'move and rename');
    const moved = await performManagedSync(engine, { sourceId: f.id, noPull: true });
    expect(moved).toMatchObject({ status: 'synced', renamed: 2, added: 0, deleted: 0 });
    expect(await pageId(engine, 'people/erin-example-2', f.id)).toBe(erin);
    expect(await pageId(engine, 'meetings/standup', f.id)).toBe(standup);
    expect(await engine.getPage('people/erin-example', { sourceId: f.id })).toBeNull();
    expect(await engine.resolveSlugWithAlias('people/erin-example', f.id)).toBe('people/erin-example-2');
    expect(await engine.resolveSlugWithAlias('inbox/standup', f.id)).toBe('meetings/standup');
    expect(await backlinkSources(engine, 'people/erin-example-2', f.id)).toEqual(['notes/b']);
    expect((await engine.getLinks('meetings/standup', { sourceId: f.id })).map(link => link.to_slug)).toEqual(['people/carol-example']);
    // The move never rewrites the user's files.
    expect(git(f.root, 'status', '--porcelain', '--', 'people', 'meetings', 'notes')).toBe('');
    // Re-extracting the unchanged link text still reaches the renamed page through its alias.
    write(f.root, 'notes/b.md', note('Note B', 'Saw [[people/erin-example]] again.'));
    commit(f.root, 'edit linking note');
    await performManagedSync(engine, { sourceId: f.id, noPull: true });
    expect(await backlinkSources(engine, 'people/erin-example-2', f.id)).toEqual(['notes/b']);
    expect((await performManagedSync(engine, { sourceId: f.id, noPull: true, full: true })).status).toMatch(/synced|up_to_date/);
    expect(await pageId(engine, 'people/erin-example-2', f.id)).toBe(erin);
  }
}), 180_000);

test('a rename that also edits the file moves the page and applies the new text', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const engine of engines) {
    const f = await fixture(engine, { 'people/dana-example.md': person('Dana Example') + 'First version with plenty of stable text for rename detection.\n' });
    await performManagedSync(engine, { sourceId: f.id, noPull: true });
    const id = await pageId(engine, 'people/dana-example', f.id);
    git(f.root, 'mv', 'people/dana-example.md', 'people/dana-example-2.md');
    write(f.root, 'people/dana-example-2.md', person('Dana Example') + 'First version with plenty of stable text for rename detection. Plus an edit.\n');
    commit(f.root, 'rename with edit');
    expect(await performManagedSync(engine, { sourceId: f.id, noPull: true })).toMatchObject({ status: 'synced', renamed: 1 });
    const page = await engine.getPage('people/dana-example-2', { sourceId: f.id });
    expect(page?.id).toBe(id);
    expect(page?.compiled_truth).toContain('Plus an edit');
    expect(readFileSync(join(f.root, 'people/dana-example-2.md'), 'utf8')).toContain('Plus an edit');
  }
}), 180_000);

test('managed sync derives links for its pages, including forward references, and stamps them fresh', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const engine of engines) {
    const f = await fixture(engine, {
      'notes/a.md': note('Note A', 'Planning with [[people/zed-example]] and [[people/alice-example]].'),
      'people/alice-example.md': person('Alice Example'),
      'people/zed-example.md': person('Zed Example'),
    });
    const first = await performManagedSync(engine, { sourceId: f.id, noPull: true });
    expect(first.links).toMatchObject({ created: 2, remaining: 0 });
    expect((await engine.getLinks('notes/a', { sourceId: f.id })).map(link => link.to_slug).sort()).toEqual(['people/alice-example', 'people/zed-example']);
    expect(await engine.countStalePagesForExtraction({ sourceId: f.id, versionTs: LINK_EXTRACTOR_VERSION_TS })).toBe(0);
    // A removed link disappears on the next sync (replace semantics).
    write(f.root, 'notes/a.md', note('Note A', 'Planning with [[people/alice-example]].'));
    commit(f.root, 'remove link');
    expect((await performManagedSync(engine, { sourceId: f.id, noPull: true })).links).toMatchObject({ removed: 1 });
    expect((await engine.getLinks('notes/a', { sourceId: f.id })).map(link => link.to_slug)).toEqual(['people/alice-example']);
  }
}), 180_000);

test('a sweep that stamps pages mid-sync cannot strand the links of pages this sync imported', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const engine of engines) {
    const f = await fixture(engine, {
      'notes/a.md': note('Note A', 'Met [[people/zed-example]].'),
      'people/zed-example.md': person('Zed Example'),
    });
    // Like a serve's idle sweep: stamp whatever exists after the first page lands, before its link target is imported.
    const stampEarly = async () => {
      const pages = await engine.executeRaw<{ slug: string }>('SELECT slug FROM pages WHERE source_id=$1', [f.id]);
      await engine.markPagesExtractedBatch(pages.map(page => ({ slug: page.slug, source_id: f.id })), new Date(Date.now() + 60_000).toISOString());
    };
    let stamped: Promise<void> | undefined;
    const result = await performManagedSync(engine, { sourceId: f.id, noPull: true,
      onProgress: progress => { if (progress.bankedFiles === 1) stamped = stampEarly(); } });
    await stamped;
    expect(result.status).toBe('first_sync');
    expect((await engine.getLinks('notes/a', { sourceId: f.id })).map(link => link.to_slug)).toEqual(['people/zed-example']);
  }
}), 180_000);

test('extract --stale on a managed brain derives links after a --no-extract sync without touching guarded rows', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const engine of engines) {
    const f = await fixture(engine, {
      'notes/a.md': note('Note A', 'Met [[people/alice-example]].'),
      'people/alice-example.md': person('Alice Example') + '\n## Timeline\n- **2024-03-01** | Joined Acme Example\n',
    });
    const synced = await performManagedSync(engine, { sourceId: f.id, noPull: true, noExtract: true });
    expect(synced.links).toBeUndefined();
    expect(await engine.getLinks('notes/a', { sourceId: f.id })).toEqual([]);
    expect(await runManagedStaleExtraction(engine, { sourceId: f.id, dryRun: true })).toMatchObject({ pages: 0, remaining: 2 });
    const printed: string[] = [];
    const stdoutWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => { printed.push(String(chunk)); return true; }) as typeof process.stdout.write;
    try { await runExtract(engine, ['--stale', '--source-id', f.id, '--json']); } finally { process.stdout.write = stdoutWrite; }
    const report = JSON.parse(printed.at(-1)!);
    expect(report).toMatchObject({ action: 'extract_stale_done', pages_processed: 2, links_created: 1, stale_remaining: 0 });
    expect(report.skipped_changed).toBeUndefined();
    expect((await engine.getLinks('notes/a', { sourceId: f.id })).map(link => link.to_slug)).toEqual(['people/alice-example']);
    expect((await engine.getTimeline('people/alice-example', { sourceId: f.id })).map(entry => entry.summary)).toEqual(['Joined Acme Example']);
  }
}), 180_000);

test('a managed brain prunes timeline rows an earlier page version left behind, and timeline_history does not resurrect them', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  const { withCoordinatedWrite } = await import('../src/core/persistence/context.ts');
  const { timelineHistoryCheck } = await import('../src/commands/doctor/checks/timeline-history.ts');
  for (const engine of engines) {
    const f = await fixture(engine, {
      'people/bea-example.md': person('Bea Example') + '\n## Timeline\n- **2024-03-01** | Joined Acme Example\n- **2024-05-01** | Left Acme Example\n',
    });
    await performManagedSync(engine, { sourceId: f.id, noPull: true });
    const [left] = await engine.executeRaw<{ date: string; source: string; summary: string }>(`SELECT to_char(t.date,'YYYY-MM-DD') AS date,t.source,t.summary
      FROM timeline_entries t JOIN pages p ON p.id=t.page_id WHERE p.source_id=$1 AND t.summary='Left Acme Example'`, [f.id]);
    expect(left).toBeDefined();
    write(f.root, 'people/bea-example.md', person('Bea Example') + '\n## Timeline\n- **2024-03-01** | Joined Acme Example\n');
    commit(f.root, 'drop a dated bullet');
    await performManagedSync(engine, { sourceId: f.id, noPull: true });
    const summaries = async () => (await engine.getTimeline('people/bea-example', { sourceId: f.id })).map(entry => entry.summary).sort();
    expect(await summaries()).toEqual(['Joined Acme Example']);
    // A row left over from before timeline reconciliation: an earlier version produced it, the current text does not.
    await engine.transaction(tx => withCoordinatedWrite(tx, [f.id], () => tx.addTimelineEntry('people/bea-example',
      { ...left, detail: '' }, { sourceId: f.id })));
    expect(await summaries()).toEqual(['Joined Acme Example', 'Left Acme Example']);
    expect((await timelineHistoryCheck(engine, f.id)).details).toMatchObject({ materializable_rows: 0 });
    const printed: string[] = [];
    const stdoutWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => { printed.push(String(chunk)); return true; }) as typeof process.stdout.write;
    try {
      await runExtract(engine, ['timeline', '--prune-orphans', '--dry-run', '--source-id', f.id, '--json']);
      await runExtract(engine, ['timeline', '--prune-orphans', '--source-id', f.id, '--json']);
    } finally { process.stdout.write = stdoutWrite; }
    expect(JSON.parse(printed.at(-2)!)).toMatchObject({ action: 'timeline_prune_orphans', dry_run: true, orphans: 1 });
    expect(JSON.parse(printed.at(-1)!)).toMatchObject({ action: 'timeline_prune_orphans', dry_run: false, removed: 1 });
    expect(await summaries()).toEqual(['Joined Acme Example']);
  }
}), 180_000);

test('a managed rename carries fence facts to the new slug once, keeping their ids', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  const fenced = (extra = '') => person('Gia Example') + 'Plenty of stable text so Git sees the move as a rename of this person page.\n' + extra + `
## Facts

<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | Lives in Lisbon | fact | 1.0 | world | medium | 2024-01-01 |  | note |  |
| 2 | Prefers tea | preference | 0.9 | world | low | 2024-02-01 |  | note |  |
<!--- gbrain:facts:end -->
`;
  const facts = (engine: BrainEngine, sourceId: string, slug: string) => engine.executeRaw<{ id: number; row_num: number | null; fact: string; expired: boolean }>(
    `SELECT id, row_num, fact, expired_at IS NOT NULL AS expired FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 ORDER BY row_num`, [sourceId, slug]);
  for (const engine of engines) {
    const f = await fixture(engine, { 'people/gia-example.md': fenced() });
    await performManagedSync(engine, { sourceId: f.id, noPull: true });
    const before = await facts(engine, f.id, 'people/gia-example');
    expect(before.map(r => [r.row_num, r.fact, r.expired])).toEqual([[1, 'Lives in Lisbon', false], [2, 'Prefers tea', false]]);
    git(f.root, 'mv', 'people/gia-example.md', 'people/gia-example-2.md');
    write(f.root, 'people/gia-example-2.md', fenced('An edit that rides along with the rename.\n'));
    commit(f.root, 'rename with facts');
    expect(await performManagedSync(engine, { sourceId: f.id, noPull: true })).toMatchObject({ status: 'synced', renamed: 1 });
    expect(await facts(engine, f.id, 'people/gia-example')).toEqual([]);
    const after = await facts(engine, f.id, 'people/gia-example-2');
    expect(after.map(r => [r.id, r.row_num, r.fact, r.expired])).toEqual(before.map(r => [r.id, r.row_num, r.fact, false]));
    const [alias] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM slug_aliases WHERE source_id=$1 AND alias_slug='people/gia-example'`, [f.id]);
    expect(alias.n).toBe(1);
  }
}), 180_000);
