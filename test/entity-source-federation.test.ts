/**
 * #6723: `entity` and `context_pack` resolve names across the caller's
 * readable sources, like `volunteer_context` already does.
 *
 * Protects: a pointer volunteered from a federated source opens with `entity`
 * and packs with `context_pack`; the home source wins a name both sources
 * hold; the rest of the walk is sorted by id (grant order never changes the
 * answer); `source_id` pins one source and a refused pin returns recall's
 * selector errors; sources outside the grant are never read; a remote
 * `__all__` stays fail-closed; two different entities sharing a slug in two
 * sources pack side by side, each named by its source; a stdio binding or a
 * thin client's .gbrain-source orders the walk without narrowing it and says
 * so when its source missed; remote cards never carry loop-backed threads.
 * Privacy invariant: each pack card's activation verdict, newer mentions and
 * enrichment come from its OWN source, never a same-slug page at home.
 * Regression: both verbs read `ctx.sourceId ?? 'default'` only, so a
 * federated pointer could not be opened and a same-named home page won.
 * Synthetic data only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import type { Notice } from '../src/core/agent-output.ts';
import { applyThinClientSourceScope } from '../src/cli/main.ts';
import { upsertOpenLoop } from '../src/core/loops/loops-store.ts';
import { withTrustPromotion } from '../src/core/persistence/context.ts';
import { enableTrustProtections } from './helpers/trust-protections.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
const noop = { info() {}, warn() {}, error() {} };
type Ctx = Partial<OperationContext> & { notices?: Notice[] };
function ctx(o: { remote?: boolean; sourceId?: string; grant?: string[]; binding?: OperationContext['explicitReadBinding']; notices?: Notice[] } = {}): OperationContext {
  return {
    engine, config: { engine: 'pglite' }, logger: noop, dryRun: false, remote: o.remote ?? true, sourceId: o.sourceId ?? 'default',
    takesHoldersAllowList: ['world'],
    ...(o.grant ? { auth: { token: 't', clientId: 'c', scopes: ['read'], allowedSources: o.grant } } : {}),
    ...(o.binding ? { explicitReadBinding: o.binding, transport: 'stdio' } : {}),
    ...(o.notices ? { emitNotice: (n: Notice) => o.notices!.push(n) } : {}),
  } as unknown as OperationContext;
}
const federated = (notices?: Notice[]) => ctx({ grant: ['default', 'wiki'], notices });
const call = async (op: string, c: OperationContext, p: Record<string, unknown>) => await operationsByName[op]!.handler(c, p) as any;
async function refusal(op: string, c: OperationContext, p: Record<string, unknown>): Promise<{ error?: string; code?: string }> {
  try { await call(op, c, p); } catch (e) { return { error: (e as any).envelope?.error ?? (e as any).verbCode ?? (e as any).code, code: (e as any).code }; }
  throw new Error('expected a refusal');
}

async function person(source: string, slug: string, title: string, body: string): Promise<number> {
  const [row] = await engine.executeRaw<{ id: number }>(
    `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline) VALUES ($1, $2, 'person', $3, $4, '') RETURNING id`,
    [slug, source, title, body]);
  return Number(row!.id);
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const id of ['wiki', 'alpha', 'secret']) await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ($1, $1, '{}') ON CONFLICT (id) DO NOTHING`, [id]);
  await person('wiki', 'people/zoe-example', 'Zoe Example', 'Zoe Example runs the wiki team.');
  await person('default', 'people/sam-example', 'Sam Example', 'The default-source Sam.');
  await person('wiki', 'people/sam-example', 'Sam Example', 'The wiki-source Sam.');
  await person('alpha', 'people/ivy-example', 'Ivy Example', 'The alpha-source Ivy.');
  await person('wiki', 'people/ivy-example', 'Ivy Example', 'The wiki-source Ivy.');
  await person('secret', 'people/hidden-example', 'Hidden Example', 'Never readable by the federated token.');
  await upsertOpenLoop(engine, {
    sourceId: 'wiki', dedupKey: 'commit:zoe0001', loopType: 'commitment_owed_by_me', counterpartySlug: 'people/zoe-example',
    summary: 'LOOP-SENTINEL send Zoe the draft', evidence: [{ message_id: 'm-1', quote: 'quote' }], detector: 'llm_extract',
  });
  for (const sourceId of ['default', 'wiki']) await upsertOpenLoop(engine, {
    sourceId, dedupKey: `commit:sam-${sourceId}`, loopType: 'commitment_owed_by_me', counterpartySlug: 'people/sam-example',
    summary: `SAM-LOOP-SENTINEL ${sourceId} send Sam the deck`, evidence: [{ message_id: `m-${sourceId}`, quote: 'quote' }], detector: 'llm_extract',
  });
}, 120_000);

afterAll(async () => { await engine.disconnect(); });

describe('#6723 federated entity resolution', () => {
  test('volunteer -> entity -> context_pack round trip on a slug that lives in a federated source', async () => {
    const volunteered = await call('volunteer_context', federated(), { window: 'user: what is Zoe Example working on?' });
    expect(volunteered.pages.map((p: any) => [p.source_id, p.slug])).toEqual([['wiki', 'people/zoe-example']]);

    const card = await call('entity', federated(), { name: 'Zoe Example' });
    expect(card.found).toBe(true);
    expect(card.card.entity).toMatchObject({ slug: 'people/zoe-example', source_id: 'wiki' });
    expect(card.card.open_threads.some((t: any) => t.loop_id !== undefined || /LOOP-SENTINEL/.test(t.text))).toBe(false);

    const rows = await call('entity', federated(), { names: ['people/zoe-example'] });
    expect(rows.results[0]).toMatchObject({ found: true, slug: 'people/zoe-example', source_id: 'wiki', next: { tool: 'entity', arguments: { name: 'people/zoe-example', source_id: 'wiki' } } });

    const pack = await call('context_pack', federated(), { entities: 'Zoe Example' });
    expect(pack.cards.map((c: any) => [c.source_id, c.slug])).toEqual([['wiki', 'people/zoe-example']]);
    expect(pack.text).toContain('`people/zoe-example` (source wiki)');
    expect(JSON.stringify(pack)).not.toContain('LOOP-SENTINEL');
  });

  test('the home source wins a name both sources hold; source_id pins the other one', async () => {
    const home = await call('entity', federated(), { name: 'Sam Example' });
    expect(home.card.entity.source_id).toBe('default');
    expect(home.card.summary).toContain('default-source Sam');
    const pinned = await call('entity', federated(), { name: 'Sam Example', source_id: 'wiki' });
    expect(pinned.card.entity.source_id).toBe('wiki');
    expect(pinned.card.summary).toContain('wiki-source Sam');
  });

  test('outside home, the walk is sorted by source id whatever the grant order', async () => {
    for (const grant of [['default', 'wiki', 'alpha'], ['wiki', 'alpha', 'default'], ['alpha', 'default', 'wiki']]) {
      const card = await call('entity', ctx({ grant }), { name: 'Ivy Example' });
      expect(card.card.entity.source_id).toBe('alpha');
    }
  });

  test('two entities sharing one slug in two sources pack side by side, each with its own source', async () => {
    const pack = await call('context_pack', federated(), { entity_refs: [{ source_id: 'default', slug: 'people/sam-example' }, { source_id: 'wiki', slug: 'people/sam-example' }] });
    expect(pack.cards.map((c: any) => [c.source_id, c.slug, c.summary])).toEqual([
      ['default', 'people/sam-example', expect.stringContaining('default-source Sam')],
      ['wiki', 'people/sam-example', expect.stringContaining('wiki-source Sam')],
    ]);
    expect(pack.cards.flatMap((c: any) => c.open_threads).some((t: any) => t.loop_id !== undefined)).toBe(false);
    expect(JSON.stringify(pack)).not.toContain('SAM-LOOP-SENTINEL');
    const local = await call('context_pack', ctx({ remote: false, grant: ['default', 'wiki'] }), { include_private: true,
      entity_refs: [{ source_id: 'default', slug: 'people/sam-example' }, { source_id: 'wiki', slug: 'people/sam-example' }] });
    expect(local.cards.map((c: any) => c.open_threads.filter((t: any) => /SAM-LOOP-SENTINEL/.test(t.text)).map((t: any) => t.text))).toEqual([
      [expect.stringContaining('SAM-LOOP-SENTINEL default')], [expect.stringContaining('SAM-LOOP-SENTINEL wiki')],
    ]);
  });

  test('a source outside the grant is never read: unpinned it is a miss, pinned it is scope_denied', async () => {
    expect((await call('entity', federated(), { name: 'Hidden Example' })).found).toBe(false);
    expect((await call('context_pack', federated(), { entities: 'Hidden Example' })).cards).toEqual([]);
    expect((await refusal('entity', federated(), { name: 'Hidden Example', source_id: 'secret' })).code).toBe('scope_denied');
    expect((await refusal('context_pack', federated(), { entity_refs: [{ source_id: 'secret', slug: 'people/hidden-example' }] })).code).toBe('scope_denied');
    expect((await refusal('entity', ctx({ remote: false }), { name: 'Zoe Example', source_id: 'ghost' })).code).toBe('not_found');
    expect((await refusal('entity', federated(), { name: 'Zoe Example', source_id: 'Bad Id!' })).code).toBe('invalid_params');
  });

  test('a remote __all__ stays fail-closed; a trusted local __all__ reads every source', async () => {
    expect((await call('entity', ctx({ sourceId: '__all__' }), { name: 'Zoe Example' })).found).toBe(false);
    expect((await refusal('entity', federated(), { name: 'Zoe Example', source_id: '__all__' })).code).toBe('invalid_params');
    expect((await call('entity', ctx({ remote: false, sourceId: '__all__' }), { name: 'Zoe Example' })).card.entity.source_id).toBe('wiki');
  });

  test('a stdio .gbrain-source binding orders the walk without narrowing it, and says when its source missed', async () => {
    const notices: Notice[] = [];
    const bound = ctx({ binding: { sourceId: 'default', via: '.gbrain-source', sourceIds: ['default', 'wiki'], optedOut: [] }, notices });
    expect((await call('entity', bound, { name: 'Zoe Example' })).card.entity.source_id).toBe('wiki');
    const narrowed = notices.filter(n => n.code === 'source_binding_narrowed');
    expect(narrowed).toHaveLength(1);
    expect(narrowed[0]!.why).toContain("'Zoe Example' resolved in source 'wiki'");
    notices.length = 0;
    expect((await call('entity', bound, { name: 'Sam Example' })).card.entity.source_id).toBe('default');
    expect(notices.filter(n => n.code === 'source_binding_narrowed')).toEqual([]);
  });

  test("a thin client's .gbrain-source becomes a preference, never a pin", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-entity-ambient-'));
    try {
      writeFileSync(join(dir, '.gbrain-source'), 'default\n');
      for (const op of ['entity', 'context_pack']) {
        const params: Record<string, unknown> = op === 'entity' ? { name: 'Zoe Example' } : { entities: 'Zoe Example' };
        await withEnv({ GBRAIN_SOURCE: undefined }, () => { applyThinClientSourceScope(operationsByName[op]!, params, dir); });
        expect(params).toMatchObject({ prefer_source_id: 'default' });
        expect(params.source_id).toBeUndefined();
        const notices: Notice[] = [];
        const res = await call(op, federated(notices), params);
        expect(op === 'entity' ? res.card.entity.source_id : res.cards[0].source_id).toBe('wiki');
        expect(notices.map(n => n.code)).toContain('source_binding_narrowed');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('#6723 privacy invariant: a pack card is gated and enriched by its own source', () => {
  test('a same-slug home page with the opposite activation verdict neither drops nor admits the federated card', async () => {
    await enableTrustProtections(engine);
    try {
      const [row] = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE source_id = 'default' AND slug = 'people/sam-example'");
      const homeId = Number(row!.id);
      await engine.transaction(tx => withTrustPromotion(tx, 'user_confirmed', () => tx.executeRaw("UPDATE pages SET trust_tier = 'agent_written' WHERE id = $1", [homeId])));
      await engine.executeRaw(`INSERT INTO write_gate_receipts (target_table, target_id, source_id, content_hash, tier, detector_version, verdict, reason_families)
        VALUES ('pages', $1, 'default', md5($1), 'agent_written', 1, 'flag', ARRAY['standing_instruction']::text[]) ON CONFLICT DO NOTHING`, [String(homeId)]);

      const wikiPack = await call('context_pack', federated(), { entity_refs: [{ source_id: 'wiki', slug: 'people/sam-example' }] });
      expect(wikiPack.cards.map((c: any) => c.source_id)).toEqual(['wiki']);
      expect(wikiPack.suppressed).toBeUndefined();

      const homePack = await call('context_pack', federated(), { entity_refs: [{ source_id: 'default', slug: 'people/sam-example' }] });
      expect(homePack.cards).toEqual([]);
      expect(homePack.suppressed?.withheld).toBe(1);
      expect(homePack.text).not.toContain('default-source Sam');
    } finally {
      await engine.unsetConfig('write_gate.external_mode');
      await engine.unsetConfig('trust.agent_activation');
      await engine.executeRaw("DELETE FROM write_gate_receipts");
    }
  });
});
