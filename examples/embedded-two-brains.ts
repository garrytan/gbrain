/**
 * Two brains in one process: the embedded-core quickstart
 * (docs/architecture/topologies.md#embedded-core-planned).
 *
 *   bun examples/embedded-two-brains.ts [dirA] [dirB]
 *
 * Each brain is a PGLite database in its own directory. The example imports a
 * markdown page into each (keyword-searchable, no embedding key needed), searches each, closes both, reopens both and reads the pages
 * back, then prints what each brain saw as JSON. Each brain must find only
 * its own page.
 *
 * Today it uses the API an embedder already has (createEngine from
 * gbrain/engine-factory; inside this repository the relative import below).
 * The embedded core (GBRA-248) replaces it with openEngine(settings), which
 * reads nothing from the process environment or the home directory.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine } from '../src/core/engine-factory.ts';
import { importFromContent } from '../src/core/import-file.ts';
import type { BrainEngine } from '../src/core/engine.ts';

export interface BrainReport { slug: string; found: string[]; reopened: string | null }

async function open(dir: string): Promise<BrainEngine> {
  const engine = await createEngine({ engine: 'pglite' });
  await engine.connect({ engine: 'pglite', database_path: join(dir, 'brain.pglite') });
  await engine.initSchema();
  return engine;
}

export async function runTwoBrains(dirs: { a: string; b: string }): Promise<Record<'a' | 'b', BrainReport>> {
  const report = {} as Record<'a' | 'b', BrainReport>;
  for (const name of ['a', 'b'] as const) {
    const slug = 'notes/quickstart-' + name;
    const engine = await open(dirs[name]);
    await importFromContent(engine, slug, '---\ntype: concept\ntitle: Quickstart ' + name + '\n---\nEmbedded quickstart page for brain ' + name + '.\n', { noEmbed: true });
    const found = (await engine.searchKeyword('quickstart')).map((r) => r.slug);
    await engine.disconnect();
    report[name] = { slug, found, reopened: null };
  }
  for (const name of ['a', 'b'] as const) {
    const engine = await open(dirs[name]);
    report[name].reopened = (await engine.getPage(report[name].slug))?.title ?? null;
    await engine.disconnect();
  }
  return report;
}

if (import.meta.main) {
  const [a, b] = process.argv.slice(2);
  const report = await runTwoBrains({
    a: a ?? mkdtempSync(join(tmpdir(), 'gbrain-quickstart-a-')),
    b: b ?? mkdtempSync(join(tmpdir(), 'gbrain-quickstart-b-')),
  });
  console.log(JSON.stringify(report));
}
