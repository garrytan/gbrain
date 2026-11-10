/**
 * #9121: scanStaleMentions must derive mentions of a segmented page (NULL body columns)
 * through the same block-wise path the rebuild uses, not report every row stale.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { scanStaleMentions } from '../src/core/by-mention.ts';
import { importFromFile } from '../src/core/import-file.ts';
import { readPageBodyPolicy } from '../src/core/page-body/limits.ts';

let engine: PGLiteEngine;
let dir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.setConfig('pages.segmented_storage', 'on');
  dir = mkdtempSync(join(tmpdir(), 'gbrain-stale-seg-'));
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('a segmented page whose mentions are still derivable has no stale links', async () => {
  await engine.putPage('companies/acme-example', {
    type: 'company', title: 'Acme Example', compiled_truth: 'Acme Example is a company.', timeline: '', frontmatter: {},
  });
  const line = (i: number) => '- ' + String(i).padStart(9, '0') + ' met Acme Example, journal line with enough text to fill a segment\n';
  const body = '# Big Person\n\n' + Array.from({ length: Math.ceil(2 * 1024 * 1024 / line(0).length) }, (_, i) => line(i)).join('');
  const file = join(dir, 'big.md');
  writeFileSync(file, '---\ntype: person\ntitle: Big Person\n---\n\n' + body);
  expect(await importFromFile(engine, file, 'people/big-person.md', { noEmbed: true, bodyPolicy: await readPageBodyPolicy(engine) }))
    .toMatchObject({ status: 'imported' });
  const [row] = await engine.executeRaw<{ body_storage: string }>("SELECT body_storage FROM pages WHERE slug='people/big-person'", []);
  expect(row!.body_storage).toBe('segmented');

  await engine.addLinksBatch([{ from_slug: 'people/big-person', to_slug: 'companies/acme-example', link_type: 'mentions', link_source: 'mentions', link_kind: 'plain' }]);
  const res = await scanStaleMentions(engine);
  expect(res.linksScanned).toBe(1);
  expect(res.staleLinks).toBe(0);
}, 120_000);
