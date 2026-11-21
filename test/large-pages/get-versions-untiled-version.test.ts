/**
 * Remote get_versions lists a page's history even when one segmented version's generation no longer tiles.
 * Protects: the version stays listed (without a size or body_ref) and the page's other versions are unaffected.
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
const SLUG = 'notes/untiled-version-example';
let engine: PGLiteEngine;
const person = (seed: number) => '---\ntype: person\ntitle: Person Example\n---\n\n# Person Example\n\n' + conversationBody(1260 * 1024, { seed }) + '\n<!-- timeline -->\n- **2026-10-01** | manual — first\n';

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

test('remote get_versions lists a version whose generation rows do not tile, without a size', async () => withEnv(env, async () => {
  await engine.setConfig('pages.segmented_storage', 'on');
  await importFromContent(engine, SLUG, person(7), { noEmbed: true });
  await importFromContent(engine, SLUG, person(8), { noEmbed: true });
  const [row] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE slug=$1', [SLUG]);
  const [version] = await engine.executeRaw<{ body_generation: number }>('SELECT body_generation FROM page_versions WHERE page_id=$1', [row!.id]);
  await engine.executeRaw('DELETE FROM page_body_manifest WHERE page_id=$1 AND gen_from<=$2 AND gen_to>$2 AND seq=(SELECT max(seq) FROM page_body_manifest WHERE page_id=$1 AND gen_from<=$2 AND gen_to>$2)',
    [row!.id, version!.body_generation]);
  const base = { engine, config: { engine: 'pglite' }, logger, dryRun: false, remote: true, transport: 'stdio', takesHoldersAllowList: ['world'] };
  for (const include_body of [false, true]) {
    const outcome = await (operationsByName.get_versions!.handler(base as never, { slug: SLUG, include_body }) as Promise<unknown[]>).then(value => ({ value }), (error: Error) => ({ error: error.message }));
    expect(outcome).toHaveProperty('value');
    const listed = (outcome as { value: Array<Record<string, unknown>> }).value;
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty('total_bytes');
    expect(listed[0]).not.toHaveProperty('body_ref');
  }
}), 300_000);
