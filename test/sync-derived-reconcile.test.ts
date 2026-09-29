/**
 * File-sync extraction reconciles derived links and timeline rows.
 *
 * Link extraction on the sync paths (sync's inline hook and the cycle's
 * incremental extract) used to be add-only, so a removed wikilink kept its
 * edge, and a corrected dated bullet kept the old timeline row next to the new
 * one. Both paths now replace a page's own markdown-derived links (as MCP
 * put_page does) and retract the timeline rows its previous text produced but
 * its current text no longer does. Rows from other producers survive.
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
import { runExtractCore } from '../src/commands/extract.ts';
import { importFromFile } from '../src/core/import-file.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await runSources(engine, ['add', 'dr', '--no-federated']);
  await runSources(engine, ['add', 'cy', '--no-federated']);
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
  const repo = mkdtempSync(join(tmpdir(), 'derived-reconcile-'));
  execSync('git init -q && git config user.email t@t && git config user.name t', { cwd: repo });
  mkdirSync(join(repo, 'notes'));
  mkdirSync(join(repo, 'people'));
  writeFileSync(join(repo, 'people/bob-example.md'), `---\ntype: person\ntitle: Bob Example\n---\n\nBob is a designer.\n`);
  return repo;
}

describe('sync inline extraction', () => {
  test('removing a wikilink removes its edge and correcting a bullet replaces its timeline row', async () => {
    const repo = gitRepo();
    const sync = () => performSync(engine, { repoPath: repo, sourceId: 'dr', noPull: true, noEmbed: true });
    execSync('git add -A && git commit -qm seed', { cwd: repo });
    await sync();
    writeFileSync(join(repo, 'notes/a.md'), note('Met with [[people/alice-example]] and [[people/bob-example]] about the widget.'));
    writeFileSync(join(repo, 'people/alice-example.md'), person('- **2024-03-01** | Joined acme-example as CTO'));
    execSync('git add -A && git commit -qm add', { cwd: repo });
    await sync();
    expect(await links('dr')).toEqual(['notes/a->people/alice-example', 'notes/a->people/bob-example']);
    expect(await timeline('dr', 'people/alice-example')).toEqual(['2024-03-01 Joined acme-example as CTO']);

    await engine.addTimelineEntry('people/alice-example', { date: '2023-01-01', source: 'enrichment', summary: 'Mentioned in a board memo' }, { sourceId: 'dr' });

    writeFileSync(join(repo, 'notes/a.md'), note('Met with [[people/alice-example]] about the widget.'));
    writeFileSync(join(repo, 'people/alice-example.md'), person('- **2024-04-01** | Joined acme-example as VP Eng'));
    execSync('git commit -qam edit', { cwd: repo });
    await sync();
    expect(await links('dr')).toEqual(['notes/a->people/alice-example']);
    expect(await timeline('dr', 'people/alice-example')).toEqual([
      '2023-01-01 Mentioned in a board memo',
      '2024-04-01 Joined acme-example as VP Eng',
    ]);
  }, 60_000);
});

describe('cycle incremental extraction', () => {
  test('the slug-scoped extract replaces links and retracts removed timeline rows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'derived-cycle-'));
    mkdirSync(join(dir, 'notes'));
    mkdirSync(join(dir, 'people'));
    const write = async (rel: string, body: string) => {
      writeFileSync(join(dir, rel), body);
      await importFromFile(engine, join(dir, rel), rel, { noEmbed: true, sourceId: 'cy' });
    };
    const extract = (slugs: string[]) => runExtractCore(engine, { mode: 'all', dir, slugs, sourceId: 'cy', quiet: true });
    await write('people/bob-example.md', `---\ntype: person\ntitle: Bob Example\n---\n\nBob.\n`);
    await write('people/carol-example.md', person('- **2024-03-01** | Joined widget-co'));
    await write('notes/b.md', note('Talked to [[people/bob-example]] and [[people/carol-example]].'));
    await extract(['notes/b', 'people/carol-example', 'people/bob-example']);
    expect(await links('cy')).toEqual(['notes/b->people/bob-example', 'notes/b->people/carol-example']);

    await write('notes/b.md', note('Talked to [[people/carol-example]].'));
    await write('people/carol-example.md', person('- **2024-05-01** | Joined widget-co'));
    await extract(['notes/b', 'people/carol-example']);
    expect(await links('cy')).toEqual(['notes/b->people/carol-example']);
    expect(await timeline('cy', 'people/carol-example')).toEqual(['2024-05-01 Joined widget-co']);
  }, 60_000);
});
