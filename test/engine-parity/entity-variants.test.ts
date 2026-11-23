/**
 * BrainEngine parity: the name-variant reads (verbs/entity-variants.ts over the typed members
 * listNameVariantCandidates, listVisibleNameVariantCandidates, listNameVariantCardCandidates and
 * readVisibleVariantPages, SQL in engine-sql/entity-reads.ts) through the MCP `entity` and `rank_entities` tools.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine arm, `entity` resolves a name with no page to its one name variant, follows a retired
 *    variant to the live page it names, and answers a name with several variants `found: false` with the same
 *    suggestions in the same order; a remote caller is never shown a private page as a suggestion or a match.
 *    `rank_entities` lists title-prefixed person duplicates and names no private one to a remote caller. Each case
 *    asserts the exact answer, so one arm alone also checks it.
 *  - Regression: entity-variants.ts ran its candidate, target and stub reads through executeRaw, so on a Rust brain the
 *    entity card's variant arm caught the refusal and answered a plain miss with no suggestions, and rank_entities named
 *    no duplicates; an engine that ignores the caller's page policy names a private page to a remote caller.
 *  - Why existing coverage misses it: test/entity-card-name-variants.test.ts and test/rank-entities.test.ts run on
 *    PGLite only.
 *  - Order: ASCII names; candidate order is most probe hits, shortest title, then slug in byte order on every arm.
 *  - Seam: none. Real engines and the real MCP dispatcher; each case runs under its own GBRAIN_HOME.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import { parityArms } from './harness.ts';

const { parityTest } = parityArms(testBackends());

async function withHome<T>(run: () => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-parity-entity-variants-'));
  try { return await withEnv({ GBRAIN_HOME: home }, run); } finally { rmSync(home, { recursive: true, force: true }); }
}

interface ToolAnswer { error: string | null; body: Record<string, unknown> | null }
async function call(engine: BrainEngine, name: string, params: Record<string, unknown>, remote = false): Promise<ToolAnswer> {
  const auth = remote ? { token: 'parity', clientId: 'parity', clientName: 'parity', scopes: ['read'], sourceId: 'default' } as never : undefined;
  const result = await dispatchToolCall(engine, name, params, remote ? { remote: true, sourceId: 'default', auth } : { remote: false, sourceId: 'default' });
  const text = (result.content[0] as { text?: string } | undefined)?.text ?? '';
  if (result.isError) return { error: /"(?:code|error)"\s*:\s*"([a-z_]+)"/.exec(text)?.[1] ?? text.slice(0, 160), body: null };
  try { return { error: null, body: JSON.parse(text) as Record<string, unknown> }; } catch { return { error: 'not_json', body: null }; }
}

type NameRow = { found: boolean; slug?: string; title?: string; match?: unknown; suggestions?: Array<{ slug: string }>; ambiguous?: boolean };
const nameView = (a: ToolAnswer) => {
  const [r] = ((a.body as { results?: NameRow[] } | null)?.results ?? []);
  return { error: a.error, found: r?.found ?? null, slug: r?.slug ?? null, match: r?.match ?? null,
    suggestions: (r?.suggestions ?? []).map(x => x.slug), ambiguous: r?.ambiguous ?? false };
};

const person = (engine: BrainEngine, slug: string, title: string, frontmatter: Record<string, unknown> = {}) =>
  engine.putPage(slug, { type: 'person' as never, title, compiled_truth: `${title} page.`, timeline: '', frontmatter }, { sourceId: 'default' });

describe('engine parity: entity name variants', () => {
  parityTest('entity answers a name with several variants found:false with the same suggestions, and hides a private one from a remote caller',
    { methods: ['listNameVariantCardCandidates'], timeout: 90_000 },
    async (engine) => withHome(async () => {
      await person(engine, 'people/example-quinn', 'Example Quinn');
      await person(engine, 'people/prof-quinn-example', 'Prof Quinn Example');
      await person(engine, 'people/dr-quinn-example', 'Dr Quinn Example', { visibility: 'private' });
      await person(engine, 'people/mr-quinn-example', 'Mr Quinn Example');
      const local = nameView(await call(engine, 'entity', { names: ['Quinn Example'] }));
      const world = nameView(await call(engine, 'entity', { names: ['Quinn Example'] }, true));
      expect({ local, world }).toEqual({
        local: { error: null, found: false, slug: null, match: null, ambiguous: true,
          suggestions: ['people/dr-quinn-example', 'people/mr-quinn-example', 'people/prof-quinn-example'] },
        world: { error: null, found: false, slug: null, match: null, ambiguous: true,
          suggestions: ['people/mr-quinn-example', 'people/prof-quinn-example', 'people/example-quinn'] },
      });
      return { local, world };
    }));

  parityTest('entity resolves a name that has no page to its one name variant, for a local and a remote caller',
    { methods: ['listNameVariantCardCandidates'], timeout: 90_000 },
    async (engine) => withHome(async () => {
      await person(engine, 'people/example-zelda', 'Example Zelda');
      await engine.putPage('notes/zelda-meeting', { type: 'note' as never, title: 'Zelda meeting', compiled_truth: 'Met Zelda Example about the plan.', timeline: '' }, { sourceId: 'default' });
      const local = nameView(await call(engine, 'entity', { names: ['Zelda Example'] }));
      const world = nameView(await call(engine, 'entity', { names: ['Zelda Example'] }, true));
      const want = { error: null, found: true, slug: 'people/example-zelda', match: { kind: 'reordered', via: 'Zelda Example' }, suggestions: [], ambiguous: false };
      expect({ local, world }).toEqual({ local: want, world: want });
      return { local, world };
    }));

  parityTest('entity follows a retired name variant to the live page it names',
    { methods: ['listNameVariantCardCandidates'], timeout: 90_000 },
    async (engine) => withHome(async () => {
      await person(engine, 'people/example-yara', 'Example Yara', { superseded_by: 'people/yq-current' });
      await person(engine, 'people/yq-current', 'Yq Current');
      const local = nameView(await call(engine, 'entity', { names: ['Yara Example'] }));
      const world = nameView(await call(engine, 'entity', { names: ['Yara Example'] }, true));
      const want = { error: null, found: true, slug: 'people/yq-current', match: { kind: 'reordered', via: 'Yara Example' }, suggestions: [], ambiguous: false };
      expect({ local, world }).toEqual({ local: want, world: want });
      return { local, world };
    }));

  parityTest('rank_entities lists title-prefixed person duplicates and names no private one to a remote caller',
    { methods: ['listNameVariantCandidates', 'listVisibleNameVariantCandidates'], timeout: 90_000 },
    async (engine) => withHome(async () => {
      await person(engine, 'people/alice-zebraexample', 'Alice Zebraexample');
      await person(engine, 'people/senator-zebraexample', 'Senator Zebraexample');
      await person(engine, 'people/mayor-zebraexample', 'Mayor Zebraexample', { visibility: 'private' });
      for (const n of ['n1', 'n2', 'n3']) await engine.putPage(`notes/${n}`, { type: 'note' as never, title: n, compiled_truth: 'Synthetic note.', timeline: '' }, { sourceId: 'default' });
      for (const [from, to] of [['notes/n1', 'people/alice-zebraexample'], ['notes/n2', 'people/alice-zebraexample'], ['notes/n3', 'people/alice-zebraexample'],
        ['notes/n1', 'people/senator-zebraexample'], ['notes/n2', 'people/senator-zebraexample'], ['notes/n1', 'people/mayor-zebraexample']]) {
        await engine.addLink(from!, to!, '', 'references', 'manual', undefined, undefined, { fromSourceId: 'default', toSourceId: 'default' });
      }
      const ranked = (a: ToolAnswer) => ({ error: a.error, entities: ((a.body?.entities ?? []) as Array<{ slug: string; inbound: number; possible_duplicates?: Array<{ slug: string }> }>)
        .map(e => ({ slug: e.slug, inbound: e.inbound, duplicates: (e.possible_duplicates ?? []).map(d => d.slug) })) });
      const local = ranked(await call(engine, 'rank_entities', { types: ['person'] }));
      const world = ranked(await call(engine, 'rank_entities', { types: ['person'] }, true));
      expect(local.error).toBeNull();
      expect(local.entities[0]).toEqual({ slug: 'people/alice-zebraexample', inbound: 3, duplicates: ['people/mayor-zebraexample', 'people/senator-zebraexample'] });
      expect(world).toEqual({ error: null, entities: [
        { slug: 'people/alice-zebraexample', inbound: 3, duplicates: ['people/senator-zebraexample'] },
        { slug: 'people/senator-zebraexample', inbound: 2, duplicates: ['people/alice-zebraexample'] },
      ] });
      return { local, world };
    }));
});
