/**
 * #9146: an expired tombstone and a batch page delete drop the slug-keyed stores the direct purge drops.
 *
 * 1. Protects: purgeDeletedPagesCoordinated and engine.deletePages remove the purged page's take_proposals,
 *    open_loops, core_edit_notices, page_aliases, slug_aliases and slug_rename_history rows in its source only.
 * 2. Fails when: any of the six keeps a row for the purged slug, or another source's row is removed.
 * 3. Real seams: in-memory PGLite, no provider calls.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { purgeDeletedPagesCoordinated } from '../src/core/persistence/purge-deleted.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-purge-slug-stores-'));
let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => {
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
});

async function seed(slug: string) {
  await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('source-b', 'source-b') ON CONFLICT DO NOTHING`);
  for (const s of ['default', 'source-b']) {
    await importFromContent(engine, slug, `---\ntitle: T\ntype: person\n---\n# T\n\nBody.\n`, { noEmbed: true, sourceId: s });
    await engine.executeRaw(`INSERT INTO take_proposals (source_id, page_slug, content_hash, prompt_version, proposal_run_id, claim_text, kind, holder, weight, model_id)
      VALUES ($1, $2, 'h', 'p', 'r', 'claim', 'take', 'h', 0.5, 'm')`, [s, slug]);
    await engine.executeRaw(`INSERT INTO open_loops (source_id, dedup_key, loop_type, summary, page_slug, detector) VALUES ($1, 'k-' || $2, 'decision_pending', 'sum', $2, 'manual')`, [s, slug]);
    await engine.executeRaw(`INSERT INTO core_edit_notices (source_id, slug, actor, base_text) VALUES ($1, $2, 'a', 'text')`, [s, slug]);
    await engine.executeRaw(`INSERT INTO page_aliases (source_id, alias_norm, slug) VALUES ($1, 'alias', $2)`, [s, slug]);
    await engine.executeRaw(`INSERT INTO slug_aliases (source_id, alias_slug, canonical_slug) VALUES ($1, 'old/redirect-' || $2, $2)`, [s, slug]);
    await engine.executeRaw(`INSERT INTO slug_rename_history (source_id, old_slug, new_slug) VALUES ($1, 'old/name-' || $2, $2)`, [s, slug]);
  }
}

async function residue(slug: string) {
  const q = async (table: string, col: string) =>
    (await engine.executeRaw<{ source_id: string }>(`SELECT source_id FROM ${table} WHERE ${col} = $1 ORDER BY 1`, [slug])).map(r => r.source_id);
  return {
    take_proposals: await q('take_proposals', 'page_slug'),
    open_loops: await q('open_loops', 'page_slug'),
    core_edit_notices: await q('core_edit_notices', 'slug'),
    page_aliases: await q('page_aliases', 'slug'),
    slug_aliases: await q('slug_aliases', 'canonical_slug'),
    slug_rename_history: await q('slug_rename_history', 'new_slug'),
  };
}
const ONLY_B = Object.fromEntries(['take_proposals', 'open_loops', 'core_edit_notices', 'page_aliases', 'slug_aliases', 'slug_rename_history'].map(t => [t, ['source-b']]));

describe('slug-keyed stores on non-direct hard deletes (#9146)', () => {
  test('the expired-tombstone purge clears them for the purged source only', () => withEnv({ GBRAIN_HOME: home }, async () => {
    const slug = 'people/alice-example';
    await seed(slug);
    await engine.softDeletePage(slug, { sourceId: 'default' });
    expect((await residue(slug)).take_proposals).toEqual(['default', 'source-b']);
    const purged = await purgeDeletedPagesCoordinated(engine, 0);
    expect(purged.slugs).toContain(slug);
    expect(await residue(slug)).toEqual(ONLY_B);
  }), 120_000);

  test('deletePages clears them for the purged source only', () => withEnv({ GBRAIN_HOME: home }, async () => {
    const slug = 'people/bob-sample';
    await seed(slug);
    await engine.deletePages([slug], { sourceId: 'default' });
    expect(await residue(slug)).toEqual(ONLY_B);
  }), 120_000);
});
