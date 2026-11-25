/** #10270 — a page whose result for its current input is held is settled work, not backlog. */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import * as publish from '../src/core/generations/publish.ts';
import { readGenerationsConfig } from '../src/core/generations/config.ts';
import { countExtractAtomsBacklog, discoverExtractablePages } from '../src/core/cycle/extract-atoms.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); });
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); });

async function hold(slug: string, pin: string, stalePolicy = false) {
  const config = await readGenerationsConfig(engine);
  if (stalePolicy) config.shrinkFloor = config.shrinkFloor === 0.9 ? 0.8 : 0.9;
  // Namespace access: on a base without the export this stays a failed expect(), not a module link error.
  const holdIdFor = (publish as any).holdIdFor ?? (() => '0'.repeat(32));
  const holdId = holdIdFor({ sourceId: 'default', kind: 'atom', ownerKey: 'source_slug:' + slug }, pin, config, 's', 'shrunk');
  await engine.executeRaw(
    `INSERT INTO derived_generations (source_id, kind, owner_key, generation, state, operation_id, hold_id, input_pin, item_set_hash, held_reason, held_context, attempts)
     VALUES ('default','atom',$1,0,'held',$2,$4,$3,'s','shrunk','{}'::jsonb,1)`, ['source_slug:' + slug, 'op-' + slug, pin, holdId]);
}

describe('held generation vs backlog (#10270)', () => {
  it('excludes a page held at its current pin from the count and discovery', async () => {
    const body = 'x'.repeat(600);
    await engine.putPage('held-page', { type: 'article', title: 'h', compiled_truth: body }, { sourceId: 'default' });
    await engine.putPage('open-page', { type: 'article', title: 'o', compiled_truth: body }, { sourceId: 'default' });
    const [row] = await engine.executeRaw<{ content_hash: string; id: number; knowledge_revision: string }>(
      `SELECT content_hash, id, knowledge_revision FROM pages WHERE slug='held-page'`);
    await hold('held-page', `${row!.content_hash}:${row!.id}:${row!.knowledge_revision}`);
    await engine.putPage('stale-page', { type: 'article', title: 's', compiled_truth: body }, { sourceId: 'default' });
    const [st] = await engine.executeRaw<{ content_hash: string; id: number; knowledge_revision: string }>(
      `SELECT content_hash, id, knowledge_revision FROM pages WHERE slug='stale-page'`);
    await hold('stale-page', `${st!.content_hash}:${st!.id}:${st!.knowledge_revision}`, true);
    const slugs = (await discoverExtractablePages(engine, 'default')).map(p => p.slug);
    expect(await countExtractAtomsBacklog(engine, 'default')).toBe(2);
    expect([...slugs].sort()).toEqual(['open-page', 'stale-page']);
  });
});
