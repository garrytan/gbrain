/**
 * G6 (git-canonical memory, docs/designs/GIT_CANONICAL_MEMORY.md): a strict source (`config.canonical = "git"`) is
 * written only through the door, which runs in managed persistence. The legacy writer of an unmanaged brain writes the
 * database row first, so `importFromContent`, `importCodeFile`, `importImageFile` and the large-page
 * `importStreamedMarkdownFile` outside the coordinator's seam (`prepare` / `coordinated`) refuse a
 * strict source (`strict_requires_managed`) and write nothing; other sources
 * import as before. The census pins the rule "no importFromContent outside the door": the only direct paths into the
 * page tables are these four functions' unprepared branches, and each one checks the target source. Red before: the
 * strict-source import committed the row. Runs on PGLite and, with DATABASE_URL, on Postgres.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importCodeFile, importFromContent, importImageFile } from '../src/core/import-file.ts';
import { importStreamedMarkdownFile } from '../src/core/page-body/streamed-import.ts';
import { enrichEntity } from '../src/core/enrichment-service.ts';
import type { PageBodyPolicy } from '../src/core/page-body/limits.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
beforeAll(async () => {
  if (backends.includes('pglite')) { const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); engines.push(engine); }
  if (backends.includes('postgres')) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) if (engine.kind === 'pglite') await engine.disconnect();
  await closePostgres?.();
});

const page = (title: string) => `---\ntype: note\ntitle: ${title}\n---\n\n${title} body.\n`;
const pageCount = async (engine: BrainEngine, sourceId: string, slug: string) => Number((await engine.executeRaw<{ n: number }>(
  'SELECT count(*)::int AS n FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]))[0]!.n);
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: string }) =>
  error.code);

for (const backend of backends) test(`[${backend}] an unmanaged brain refuses a direct import into a strict source and writes nothing; other sources import`, async () => {
  const engine = engines[backends.indexOf(backend)]!;
  await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('source-a', 'source-a', '{"canonical":"git"}'::jsonb) ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config`);
  expect(await refusal(importFromContent(engine, 'notes/alice-example', page('Alice'), { noEmbed: true, sourceId: 'source-a' })))
    .toEqual('strict_requires_managed');
  expect(await refusal(importCodeFile(engine, 'src/acme-example.ts', 'export const acme = 1;\n', { noEmbed: true, sourceId: 'source-a' })))
    .toEqual('strict_requires_managed');
  expect(await refusal(importImageFile(engine, join(import.meta.dir, 'no-such-dir', 'acme-example.png'), 'img/acme-example.png', { noEmbed: true, sourceId: 'source-a' })))
    .toEqual('strict_requires_managed');
  const now = new Date();
  expect(await refusal(importStreamedMarkdownFile(engine, join(import.meta.dir, 'no-such-dir', 'large.md'), 'notes/large.md', { noEmbed: true, sourceId: 'source-a' },
    { size: 1, mtimeMs: 0, birthtime: now, mtime: now }, {} as PageBodyPolicy)))
    .toEqual('strict_requires_managed');
  // extract_entities' unmanaged branch used to fall back to a direct page write when the import refused.
  expect(await refusal(enrichEntity(engine, { entityName: 'Alice Example', entityType: 'person', context: 'met at the offsite', sourceSlug: 'notes/offsite' }, { sourceId: 'source-a' })))
    .toEqual('strict_requires_managed');
  expect(await pageCount(engine, 'source-a', 'people/alice-example')).toBe(0);
  expect(await pageCount(engine, 'source-a', 'notes/alice-example')).toBe(0);
  expect(await pageCount(engine, 'source-a', 'acme-example-ts')).toBe(0);
  expect((await importFromContent(engine, 'notes/alice-example', page('Alice'), { noEmbed: true })).status).toBe('imported');
  expect(await pageCount(engine, 'default', 'notes/alice-example')).toBe(1);
  await engine.executeRaw("UPDATE sources SET config = config - 'canonical' WHERE id='source-a'");
  expect((await importFromContent(engine, 'notes/alice-example', page('Alice'), { noEmbed: true, sourceId: 'source-a' })).status).toBe('imported');
}, 60_000);

// test-reads-source-ok[structural]: the census is a source-text tripwire by design; the planted copies prove it flags a bypass.
const root = join(import.meta.dir, '..');
/** Each named function whose branch outside the coordinator's seam writes the page tables, with whether that branch checks the target source. */
function unpreparedGuards(text: string, names: string[]): Record<string, boolean> {
  const file = ts.createSourceFile('source.ts', text, ts.ScriptTarget.Latest, true);
  const out: Record<string, boolean> = {};
  file.forEachChild(node => {
    if (!ts.isFunctionDeclaration(node) || !node.name || !names.includes(node.name.text) || !node.body) return;
    out[node.name.text] = node.body.statements.some(statement => {
      if (!ts.isIfStatement(statement) || !['!opts.prepare', '!opts.coordinated'].includes(statement.expression.getText())) return false;
      const call = statement.thenStatement.getText();
      return call.startsWith('await assertUnmanagedCanonicalWriter(') && /sourceId:/.test(call);
    });
  });
  return out;
}

test('census: every direct import write (importFromContent, importCodeFile, importImageFile, importStreamedMarkdownFile) checks its source before writing', () => {
  const names = ['importFromContent', 'importCodeFile', 'importImageFile'];
  // test-reads-source-ok[structural]: the census is an AST tripwire over the import entry points; planted removals prove it flags a missing guard.
  const text = readFileSync(join(root, 'src/core/import-file.ts'), 'utf8');
  const fileGuard = "if (!opts.prepare) await assertUnmanagedCanonicalWriter(engine, 'direct file import', { sourceId: opts.sourceId ?? 'default' });";
  const lastFileGuard = text.lastIndexOf(fileGuard);
  expect(unpreparedGuards(text, names)).toEqual({ importFromContent: true, importCodeFile: true, importImageFile: true });
  expect(unpreparedGuards(text.replace("'direct content import', { sourceId: sourceId ?? 'default' })", "'direct content import')"), names))
    .toEqual({ importFromContent: false, importCodeFile: true, importImageFile: true });
  expect(unpreparedGuards(text.replace(fileGuard, ''), names))
    .toEqual({ importFromContent: true, importCodeFile: false, importImageFile: true });
  expect(unpreparedGuards(text.slice(0, lastFileGuard) + text.slice(lastFileGuard + fileGuard.length), names))
    .toEqual({ importFromContent: true, importCodeFile: true, importImageFile: false });
  // test-reads-source-ok[structural]: the same census over the streamed import entry point.
  const streamed = readFileSync(join(root, 'src/core/page-body/streamed-import.ts'), 'utf8');
  expect(unpreparedGuards(streamed, ['importStreamedMarkdownFile'])).toEqual({ importStreamedMarkdownFile: true });
  expect(unpreparedGuards(streamed.replace("'direct content import', { sourceId: opts.sourceId ?? 'default' })", "'direct content import')"), ['importStreamedMarkdownFile']))
    .toEqual({ importStreamedMarkdownFile: false });
});
