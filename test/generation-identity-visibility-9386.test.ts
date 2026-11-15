/**
 * #9386: `repair visibility` stamps an explicit visibility on a pre-ledger atom. The atom must still be adopted against
 * the extractor-written page version, and adoption keeps the stamped visibility. PGLite, real repair path.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { serializeMarkdown } from '../src/core/markdown.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { resolveRepairScope, runRepair } from '../src/core/repair/core.ts';
import { visibilityRepair } from '../src/core/repair/visibility.ts';
import { atomGenerationAdapter, atomOwnerKey } from '../src/core/generations/adapters/atoms.ts';
import { pageIdentityHash } from '../src/core/generations/adapters/page.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
const home = mkdtempSync(join(tmpdir(), 'gbrain-9386-'));

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

async function seed(slug: string, type: string, frontmatter: Record<string, unknown>, body: string) {
  const result = await importFromContent(engine, slug, serializeMarkdown(frontmatter, body, '', { type: type as never, title: slug, tags: [] }),
    { noEmbed: true, forceRechunk: true });
  expect(['imported', 'skipped']).toContain(result.status);
}

describe('#9386 atoms stamped by repair visibility stay adoptable', () => {
  test('a private-origin atom repaired to private matches its extractor version and stays private', async () => {
    await seed('notes/private-origin', 'note', { visibility: 'private' }, 'A private planning record.');
    const extractor = { source_slug: 'notes/private-origin', extracted_by: 'extract_atoms-v0.41.2.1' };
    await seed('atoms/legacy-insight', 'atom', extractor, 'An insight distilled from the planning record.');
    await engine.createVersion('atoms/legacy-insight', { sourceId: 'default' });
    await withEnv({ GBRAIN_HOME: home }, async () => {
      await runRepair({ engine, config: { engine: 'pglite', embedding_disabled: true }, logger: { info() {}, warn() {}, error() {} },
        dryRun: false, remote: false, sourceId: 'default' } as never, visibilityRepair, await resolveRepairScope(engine), { apply: true });
    });
    const [row] = await engine.executeRaw<{ v: string | null }>("SELECT frontmatter->>'visibility' AS v FROM pages WHERE slug='atoms/legacy-insight'");
    expect(row?.v).toBe('private');

    const key = { kind: 'atom', sourceId: 'default', ownerKey: atomOwnerKey({ kind: 'page', slug: 'notes/private-origin' }) };
    const items = await atomGenerationAdapter.readItems(engine, key, []);
    const owned = [...items.values()].filter(item => item.key === 'atoms/legacy-insight');
    expect(owned).toHaveLength(1);
    expect([...await atomGenerationAdapter.legacyEvidence(engine, key, owned)]).toEqual(['atoms/legacy-insight']);
    await atomGenerationAdapter.completeItems!(engine, key, ['atoms/legacy-insight'], undefined);
    const [adopted] = await engine.executeRaw<{ v: string | null; h: string | null }>("SELECT frontmatter->>'visibility' AS v, frontmatter->>'source_hash' AS h FROM pages WHERE slug='atoms/legacy-insight'");
    expect(adopted?.h).toBeTruthy();
    expect(adopted?.v).toBe('private');
  }, 120_000);

  test('a content edit still changes the identity', () => {
    const base = { type: 'atom', title: 'T', timeline: '', tags: [] as string[], frontmatter: { visibility: 'private' } };
    expect(pageIdentityHash({ ...base, compiled_truth: 'edited' })).not.toBe(pageIdentityHash({ ...base, compiled_truth: 'body' }));
  });
});
