/**
 * #10002: remote get_versions of a page with one segmented version whose generation rows no longer tile (a page
 * repair segmented-tiling republished keeps its damaged generation as a version by reference).
 * Protects: the list still returns every version; the unreadable one is flagged body_unreadable with no size and no
 * body_ref, the readable ones keep total_bytes / body_ref, and the live page reads as before.
 * Fails when: one unreadable version refuses the whole list with page_body_rows_unreadable.
 * PGLite.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { operationsByName } from '../../src/core/operations.ts';
import { conversationBody } from '../helpers/conversation-page.ts';
import { withEnv } from '../helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-untiled-version-'));
const env = { GBRAIN_HOME: home, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
const logger = { info() {}, warn() {}, error() {} };
const SLUG = 'people/person-example';
let engine: PGLiteEngine;
const person = (seed: number) => '---\ntype: person\ntitle: Person Example\n---\n\n# Person Example\n\n' + conversationBody(1260 * 1024, { seed })
  + '\n<!-- timeline -->\n- **2026-10-01** | manual — first\n';

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

test('remote get_versions lists a version whose generation rows do not tile, flagged and without a size', async () => withEnv(env, async () => {
  await engine.setConfig('pages.segmented_storage', 'on');
  for (const seed of [1, 2, 3]) await importFromContent(engine, SLUG, person(seed), { noEmbed: true });
  const [page] = await engine.executeRaw<{ id: number; body_generation: number }>('SELECT id, body_generation::int AS body_generation FROM pages WHERE slug=$1', [SLUG]);
  const versions = await engine.executeRaw<{ id: number; body_generation: number }>(
    "SELECT id, body_generation::int AS body_generation FROM page_versions WHERE page_id=$1 AND body_storage='segmented' ORDER BY body_generation", [page!.id]);
  expect(versions).toHaveLength(2);
  const damaged = versions[0]!;
  const removed = await engine.executeRaw(`DELETE FROM page_body_manifest WHERE page_id=$1 AND staging_id IS NULL AND gen_from<=$2 AND gen_to>$2 AND gen_to<=$3
    AND seq=(SELECT max(seq) FROM page_body_manifest WHERE page_id=$1 AND staging_id IS NULL AND gen_from<=$2 AND gen_to>$2 AND gen_to<=$3) RETURNING seq`,
    [page!.id, damaged.body_generation, page!.body_generation]);
  expect(removed).toHaveLength(1);

  const remote = { engine, config: { engine: 'pglite' }, logger, dryRun: false, remote: true, transport: 'stdio', takesHoldersAllowList: ['world'] } as never;
  for (const include_body of [false, true]) {
    const listed = await operationsByName.get_versions!.handler(remote, { slug: SLUG, include_body }) as Array<Record<string, unknown>>;
    expect(listed.map(v => Number(v.id)).sort()).toEqual(versions.map(v => Number(v.id)).sort());
    const bad = listed.find(v => Number(v.id) === Number(damaged.id))!;
    const good = listed.find(v => Number(v.id) === Number(versions[1]!.id))!;
    expect(bad).toMatchObject({ body_unreadable: true });
    expect(bad).not.toHaveProperty('total_bytes');
    expect(bad).not.toHaveProperty('body_bytes');
    expect(bad).not.toHaveProperty('body_ref');
    expect(good).not.toHaveProperty('body_unreadable');
    expect(good.total_bytes).toEqual(expect.any(Number));
    if (include_body) expect(good.body_ref).toMatchObject({ version_id: good.id, total_bytes: good.total_bytes });
  }
  const local = await operationsByName.get_versions!.handler({ engine, config: { engine: 'pglite' }, logger, dryRun: false, remote: false } as never, { slug: SLUG }) as unknown[];
  expect(local).toHaveLength(2);
  const live = await operationsByName.get_page!.handler(remote, { slug: SLUG, max_bytes: 1024 }).then(() => 'read', (error: { code?: string }) => error.code);
  expect(live).not.toBe('page_body_rows_unreadable');
}), 300_000);
