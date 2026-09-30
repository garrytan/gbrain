/**
 * Every extraction path reconciles a page's derived links and timeline rows
 * with its current markdown (#5170, #4649).
 *
 * Sync's inline hook and the cycle's incremental extract already replaced
 * links and retracted timeline rows the previous version produced. The
 * `extract --stale` sweep, the full-walk `gbrain extract` (file and DB
 * source) and pages edited several times between extractions still kept
 * removed rows. A timeline row is retracted when an earlier version of the
 * page produced it and the current text no longer does; rows no version ever
 * produced (enrichment, meeting fan-out) are never touched.
 *
 * PGLite in-memory, no embeddings ($0).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runSources } from '../src/commands/sources.ts';
import { performSync } from '../src/commands/sync.ts';
import { runExtract, runExtractCore, extractStaleFromDB } from '../src/commands/extract.ts';
import { importFromFile } from '../src/core/import-file.ts';
import { pruneTimelineOrphans } from '../src/core/timeline-extract.ts';
import { timelineOrphansCheck } from '../src/commands/doctor/checks/timeline-orphans.ts';
import { categorizeCheck } from '../src/core/doctor-categories.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const id of ['st', 'fw', 'db', 'gap', 'pr', 'pr2']) await runSources(engine, ['add', id, '--no-federated']);
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

const links = async (sourceId: string) => (await engine.executeRaw<{ f: string; t: string }>(
  `SELECT f.slug f, t.slug t FROM links l JOIN pages f ON f.id = l.from_page_id JOIN pages t ON t.id = l.to_page_id
    WHERE f.source_id = $1 ORDER BY 1, 2`, [sourceId])).map(r => `${r.f}->${r.t}`);

const timeline = async (sourceId: string, slug: string) => (await engine.executeRaw<{ d: string; summary: string }>(
  `SELECT t.date::text d, t.summary FROM timeline_entries t JOIN pages p ON p.id = t.page_id
    WHERE p.source_id = $1 AND p.slug = $2 ORDER BY 1, 2`, [sourceId, slug])).map(r => `${r.d} ${r.summary}`);

const note = (body: string) => `---\ntype: note\ntitle: A\n---\n\n${body}\n`;
const person = (bullet: string) =>
  `---\ntype: person\ntitle: Alice Example\n---\n\nAlice is an engineer.\n\n<!-- timeline -->\n\n## Timeline\n\n${bullet}\n`;

function gitRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'timeline-reconcile-'));
  execSync('git init -q && git config user.email t@t && git config user.name t', { cwd: repo });
  mkdirSync(join(repo, 'notes'));
  mkdirSync(join(repo, 'people'));
  writeFileSync(join(repo, 'people/bob-example.md'), `---\ntype: person\ntitle: Bob Example\n---\n\nBob is a designer.\n`);
  return repo;
}

function brainDir() {
  const dir = mkdtempSync(join(tmpdir(), 'timeline-walk-'));
  mkdirSync(join(dir, 'notes'));
  mkdirSync(join(dir, 'people'));
  return dir;
}

async function writeAndImport(dir: string, sourceId: string, rel: string, body: string) {
  writeFileSync(join(dir, rel), body);
  await importFromFile(engine, join(dir, rel), rel, { noEmbed: true, sourceId });
}

describe('extract --stale (#5170)', () => {
  test('retracts a removed bullet even after several unextracted edits, keeps other producers', async () => {
    const repo = gitRepo();
    const sync = () => performSync(engine, { repoPath: repo, sourceId: 'st', noPull: true, noEmbed: true, noExtract: true });
    const stale = () => extractStaleFromDB(engine, { dryRun: false, jsonMode: false, quiet: true, sourceIdFilter: 'st', catchUp: true });
    writeFileSync(join(repo, 'notes/a.md'), note('Met with [[people/alice-example]] and [[people/bob-example]].'));
    writeFileSync(join(repo, 'people/alice-example.md'), person('- **2030-06-15** | synthetic event alpha'));
    execSync('git add -A && git commit -qm seed', { cwd: repo });
    await sync();
    await stale();
    expect(await links('st')).toEqual(['notes/a->people/alice-example', 'notes/a->people/bob-example']);
    expect(await timeline('st', 'people/alice-example')).toEqual(['2030-06-15 synthetic event alpha']);
    await engine.addTimelineEntry('people/alice-example', { date: '2023-01-01', source: 'enrichment', summary: 'Mentioned in a board memo' }, { sourceId: 'st' });

    writeFileSync(join(repo, 'people/alice-example.md'), person('- **2030-07-01** | synthetic event beta'));
    execSync('git commit -qam edit1', { cwd: repo });
    await sync();
    writeFileSync(join(repo, 'notes/a.md'), note('Met with [[people/alice-example]].'));
    writeFileSync(join(repo, 'people/alice-example.md'), person('- **2030-08-01** | synthetic event gamma'));
    execSync('git commit -qam edit2', { cwd: repo });
    await sync();
    await stale();

    expect(await links('st')).toEqual(['notes/a->people/alice-example']);
    expect(await timeline('st', 'people/alice-example')).toEqual([
      '2023-01-01 Mentioned in a board memo',
      '2030-08-01 synthetic event gamma',
    ]);
  }, 60_000);
});

describe('full-walk extract', () => {
  test('file walk replaces links and timeline rows like per-file sync', async () => {
    const dir = brainDir();
    const walk = () => runExtractCore(engine, { mode: 'all', dir, sourceId: 'fw', quiet: true });
    await writeAndImport(dir, 'fw', 'people/bob-example.md', `---\ntype: person\ntitle: Bob Example\n---\n\nBob.\n`);
    await writeAndImport(dir, 'fw', 'people/carol-example.md', person('- **2024-03-01** | Joined widget-co'));
    await writeAndImport(dir, 'fw', 'notes/b.md', note('Talked to [[people/bob-example]] and [[people/carol-example]].'));
    await walk();
    expect(await links('fw')).toEqual(['notes/b->people/bob-example', 'notes/b->people/carol-example']);
    await engine.addTimelineEntry('people/carol-example', { date: '2023-01-01', source: 'enrichment', summary: 'Mentioned in a memo' }, { sourceId: 'fw' });

    await writeAndImport(dir, 'fw', 'notes/b.md', note('Talked to [[people/carol-example]].'));
    await writeAndImport(dir, 'fw', 'people/carol-example.md', person('- **2024-05-01** | Joined widget-co'));
    await walk();
    expect(await links('fw')).toEqual(['notes/b->people/carol-example']);
    expect(await timeline('fw', 'people/carol-example')).toEqual(['2023-01-01 Mentioned in a memo', '2024-05-01 Joined widget-co']);
  }, 60_000);

  test('DB-source timeline walk retracts removed rows', async () => {
    const dir = brainDir();
    await writeAndImport(dir, 'db', 'people/dana-example.md', person('- **2024-03-01** | Joined widget-co'));
    await runExtract(engine, ['timeline', '--source', 'db', '--source-id', 'db', '--json']);
    expect(await timeline('db', 'people/dana-example')).toEqual(['2024-03-01 Joined widget-co']);
    await writeAndImport(dir, 'db', 'people/dana-example.md', person('- **2024-06-01** | Left widget-co'));
    await runExtract(engine, ['timeline', '--source', 'db', '--source-id', 'db', '--json']);
    expect(await timeline('db', 'people/dana-example')).toEqual(['2024-06-01 Left widget-co']);
  }, 60_000);
});

describe('sync inline extraction after unextracted edits', () => {
  test('rows from versions older than the previous one are retracted too', async () => {
    const repo = gitRepo();
    const sync = (noExtract: boolean) => performSync(engine, { repoPath: repo, sourceId: 'gap', noPull: true, noEmbed: true, noExtract });
    execSync('git add -A && git commit -qm seed', { cwd: repo });
    await sync(false);
    writeFileSync(join(repo, 'people/alice-example.md'), person('- **2024-01-01** | first'));
    execSync('git add -A && git commit -qm add', { cwd: repo });
    await sync(false);
    expect(await timeline('gap', 'people/alice-example')).toEqual(['2024-01-01 first']);
    writeFileSync(join(repo, 'people/alice-example.md'), person('- **2024-02-01** | second'));
    execSync('git commit -qam e1', { cwd: repo });
    await sync(true);
    writeFileSync(join(repo, 'people/alice-example.md'), person('- **2024-03-01** | third'));
    execSync('git commit -qam e2', { cwd: repo });
    await sync(false);
    expect(await timeline('gap', 'people/alice-example')).toEqual(['2024-03-01 third']);
  }, 60_000);
});

describe('one-time orphan prune (#4649)', () => {
  async function seedLegacyOrphans(sourceId: string) {
    const dir = brainDir();
    // Before v0.59.11 every extraction was insert-only: each edit left its old row behind.
    for (const [date, summary] of [['2024-01-01', 'first'], ['2024-02-01', 'second'], ['2024-03-01', 'third']]) {
      await writeAndImport(dir, sourceId, 'people/erin-example.md', person(`- **${date}** | ${summary}`));
      await engine.addTimelineEntry('people/erin-example', { date, source: 'markdown', summary }, { sourceId });
    }
    await engine.addTimelineEntry('people/erin-example', { date: '2023-01-01', source: 'enrichment', summary: 'Mentioned in a memo' }, { sourceId });
  }

  test('dry run reports orphans without deleting; apply removes only version-produced rows', async () => {
    await seedLegacyOrphans('pr');
    const check = await timelineOrphansCheck(engine);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('gbrain extract timeline --prune-orphans');
    expect(check.message).toContain('pr:people/erin-example');
    expect(categorizeCheck('timeline_orphans')).toBe('brain');
    const preview = await pruneTimelineOrphans(engine, { sourceId: 'pr', dryRun: true });
    expect(preview.orphans).toBe(2);
    expect(preview.removed).toBe(0);
    expect((await timeline('pr', 'people/erin-example')).length).toBe(4);

    const applied = await pruneTimelineOrphans(engine, { sourceId: 'pr', dryRun: false });
    expect(applied.removed).toBe(2);
    expect(await timeline('pr', 'people/erin-example')).toEqual(['2023-01-01 Mentioned in a memo', '2024-03-01 third']);
    expect((await pruneTimelineOrphans(engine, { sourceId: 'pr', dryRun: true })).orphans).toBe(0);
    expect((await timelineOrphansCheck(engine)).status).toBe('ok');
  }, 60_000);

  test('the CLI prune is source-scoped', async () => {
    await seedLegacyOrphans('pr2');
    await runExtract(engine, ['timeline', '--prune-orphans', '--source-id', 'pr', '--json']);
    expect((await timeline('pr2', 'people/erin-example')).length).toBe(4);
    await runExtract(engine, ['timeline', '--prune-orphans', '--source-id', 'pr2', '--json']);
    expect(await timeline('pr2', 'people/erin-example')).toEqual(['2023-01-01 Mentioned in a memo', '2024-03-01 third']);
  }, 60_000);
});
