/**
 * BrainEngine parity: `resolveAliases` under `excludePrivate`, the trust floor (`minTrust`) and the flagged-page filter
 * (`suppressFlagged`), and the search alias fan-out that reads it.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: `readAliases` (src/core/search/read-enrichment.ts) applies `pageReadFilter` twice: to the page an alias
 *    row names (`p`) and to the live page whose exact title shadows a derived alias (`t`). Under `excludePrivate` an
 *    alias of a page the page policy hides does not answer, and a hidden page's title does not shadow a readable
 *    derived alias. Under `minTrust` the pages below the floor, and under `suppressFlagged` the flagged pages at or
 *    below `agent_written`, neither answer nor shadow. The best origin per source is chosen after the filter, so a
 *    dropped frontmatter alias lets a declared one answer. Every engine arm returns the same map.
 *  - Regression: an engine that refuses one of these options makes the search fan-out (`resolveQueryEntities`, whose
 *    `.catch` reads a refusal as no aliases) lose every alias match with no error; one that filters the alias page but
 *    not its title shadow hides a readable alias behind a private or untrusted title; one that picks the best origin
 *    before it filters loses the declared fallback.
 *  - Why existing coverage misses it: sync-aliases.test.ts and import-writes.test.ts pass only `sourceId` and
 *    `sourceIds`; alias-fanout-reads.test.ts stubs `resolveAliases`.
 *  - Order: the map lists aliases in byte order, and an alias's pages by source then slug in byte order, on every
 *    engine. `readAliases` sorts its text keys `COLLATE "C"`, so a Postgres database with a locale collation (which
 *    sorts `ábc` before `alpha` and `companies/ab` before `companies/a-c`) gives the same order as PGLite and the Rust
 *    store, and a caller that takes the first page takes the same one.
 *  - Caller policy: a caller's reader identity (its member id and groups) opens a page whose `readable_by` names it,
 *    and a private-readable grant opens a private page of a granted source that is not a pinned question. The Rust
 *    store reads both from the policy the TypeScript member sends, so every engine returns the same pages.
 *  - Seam: none. Real engines, typed methods only.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { DerivedAliasRow } from '../../src/core/engine-sql/pages.ts';
import type { PageReadScope } from '../../src/core/types.ts';
import { withRequestConfigSnapshot } from '../../src/core/config-snapshot.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';
import { resolveQueryEntities } from '../../src/core/search/alias-fanout.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { parityArms } from './harness.ts';

const { parityTest } = parityArms(testBackends());

type Origin = 'frontmatter' | 'declared';

/** One page per case: [slug, title, frontmatter, declared tier (null: the default), flag reason families, aliases]. */
type Row = [slug: string, title: string, frontmatter: Record<string, unknown>, tier: string | null, flag: string[] | null, aliases: Array<[string, Origin]>];

async function write(engine: BrainEngine, rows: Row[]): Promise<void> {
  for (const [slug, title, frontmatter, tier, flag, aliases] of rows) {
    const put = (e: BrainEngine) => e.putPage(slug, { type: 'company', title, compiled_truth: `${title} body.`, timeline: '', frontmatter });
    if (tier) {
      await engine.transaction(async (tx) => {
        await tx.applyTransactionSettings(['gbrain.write_trust_tier', 'gbrain.write_origin'], [tier, JSON.stringify({ channel: tier })]);
        await put(tx);
      });
    } else {
      await put(engine);
    }
    if (flag) {
      await engine.upsertPageWriteGateReceipt('default', slug, {
        content_hash: 'h1', tier: 'agent_written', detector_version: 1, verdict: 'flag', reason_families: flag,
        reasons: flag, detector_error: false, request_id: null,
      });
    }
    const front = aliases.filter(([, o]) => o === 'frontmatter').map(([a]) => a);
    if (front.length) await engine.setPageAliases(slug, 'default', front);
    const derived: DerivedAliasRow[] = aliases.filter(([, o]) => o === 'declared')
      .map(([alias_norm]) => ({ alias_norm, origin: 'declared', case_sensitive: false, alias_text: alias_norm }));
    if (derived.length) await engine.replaceDerivedAliases(slug, 'default', derived);
  }
}

const TRUST: Row[] = [
  ['companies/curated', 'Curated Co', {}, 'operator_curated', null, [['curated name', 'frontmatter']]],
  ['companies/observed', 'Observed Co', {}, 'tool_observed', null, [['observed name', 'frontmatter']]],
  ['companies/agent', 'Agent Co', {}, 'agent_written', null, [['agent name', 'frontmatter']]],
  ['companies/agent-flagged', 'Flagged Co', {}, 'agent_written', ['override'], [['flagged name', 'frontmatter']]],
  ['companies/agent-other-flag', 'Other Flag Co', {}, 'agent_written', ['other'], [['other flag name', 'frontmatter']]],
  ['companies/curated-flagged', 'Curated Flagged Co', {}, 'operator_curated', ['override'], [['curated flagged name', 'frontmatter']]],
  ['companies/untiered-flagged', 'Untiered Co', {}, null, ['credential'], [['untiered name', 'frontmatter']]],
  // The frontmatter alias is on an untrusted page; under a floor the declared alias of a trusted page answers.
  ['companies/outside', 'Outside Co', {}, 'external_untrusted', null, [['shared name', 'frontmatter']]],
  ['companies/declared-fallback', 'Fallback Co', {}, 'operator_curated', null, [['shared name', 'declared']]],
  // Derived aliases shadowed by another page's exact title: an untrusted title and a flagged agent title.
  ['companies/shadow-target', 'Shadow Target Co', {}, 'operator_curated', null, [['low shadow', 'declared']]],
  ['notes/low-shadow', 'Low Shadow', {}, 'external_untrusted', null, []],
  ['companies/flag-target', 'Flag Target Co', {}, 'operator_curated', null, [['flag shadow', 'declared']]],
  ['notes/flag-shadow', 'Flag Shadow', {}, 'agent_written', ['override'], []],
  // The fan-out entity: no page holds its title, so only its alias names it.
  ['companies/acme-example', 'Acme Example Holdings', {}, 'operator_curated', null, [['acme example', 'frontmatter']]],
  ['companies/widget-co', 'Widget Holdings', {}, 'external_untrusted', null, [['widget co', 'frontmatter']]],
];

const PRIVACY: Row[] = [
  ['companies/open', 'Open Co', {}, null, null, [['open name', 'frontmatter']]],
  ['companies/private', 'Private Co', { visibility: 'private' }, null, null, [['private name', 'frontmatter']]],
  ['companies/readers', 'Readers Co', { readable_by: ['alice-example'] }, null, null, [['readers name', 'frontmatter']]],
  ['companies/access-alias', 'Restricted Co', { access: 'Restricted' }, null, null, [['restricted name', 'frontmatter']]],
  // Not an atom, so its private origin does not hide it.
  ['companies/origin-private', 'Origin Co', { visibility: 'world', source_slug: 'companies/private' }, null, null, [['origin name', 'frontmatter']]],
  // A frontmatter alias on a private page; the declared alias of an open page answers when it is hidden.
  ['companies/private-front', 'Private Front Co', { visibility: 'private' }, null, null, [['split name', 'frontmatter']]],
  ['companies/open-declared', 'Open Declared Co', {}, null, null, [['split name', 'declared']]],
  // A derived alias whose name is the exact title of a private page.
  ['companies/acme-example', 'Acme Example Holdings', {}, null, null, [['acme example', 'declared']]],
  ['notes/acme-crm', 'Acme Example', { visibility: 'private' }, null, null, []],
];

/** A member, alice-example, in group team-a. */
const ALICE = ['member:alice-example', 'group:team-a'];

/**
 * Pages a reader identity and a private-readable grant open or keep closed. Readers normalize as
 * gbrain_access_readers does: a bare id is a member, edge spaces trim and ASCII lower-cases; a value
 * that is not a string list, or holds one invalid entry, reads as nobody.
 */
const CALLER: Row[] = [
  ['companies/open', 'Open Co', {}, null, null, [['open name', 'frontmatter']]],
  ['companies/private', 'Private Co', { visibility: 'private' }, null, null, [['private name', 'frontmatter']]],
  ['companies/alice', 'Alice Co', { readable_by: ['alice-example'] }, null, null, [['alice name', 'frontmatter']]],
  ['companies/team', 'Team Co', { readable_by: 'group:team-a' }, null, null, [['team name', 'frontmatter']]],
  ['companies/mixed-case', 'Mixed Co', { readable_by: [' Member:Alice-Example '] }, null, null, [['mixed case name', 'frontmatter']]],
  ['companies/bob', 'Bob Co', { readable_by: ['bob-example', 'group:team-b'] }, null, null, [['bob name', 'frontmatter'], ['bob declared name', 'declared']]],
  ['companies/malformed', 'Malformed Co', { readable_by: [42] }, null, null, [['malformed name', 'frontmatter']]],
  ['companies/bad-entry', 'Bad Entry Co', { readable_by: ['alice-example', 'not valid!'] }, null, null, [['bad entry name', 'frontmatter']]],
  ['companies/empty-list', 'Empty List Co', { readable_by: [] }, null, null, [['empty list name', 'frontmatter']]],
  ['companies/private-reader', 'Private Reader Co', { visibility: 'private', readable_by: ['alice-example'] }, null, null, [['private reader name', 'frontmatter']]],
  ['companies/pinned', 'Pinned Co', { readable_by: ['alice-example'], pinned_question: true }, null, null, [['pinned name', 'frontmatter']]],
];

/** Aliases and slugs whose byte order differs from a locale collation's order. */
const ORDER: Row[] = [
  ['companies/ab', 'Ab Co', {}, null, null, [['shared order', 'frontmatter'], ['zulu', 'frontmatter']]],
  ['companies/a-c', 'Ac Co', {}, null, null, [['shared order', 'frontmatter'], ['Zulu', 'frontmatter']]],
  ['companies/eclair', 'Eclair Co', {}, null, null, [['éclair', 'frontmatter'], ['ábc', 'declared']]],
  ['companies/alpha', 'Alpha Co', {}, null, null, [['alpha', 'frontmatter'], ['a-z', 'frontmatter'], ['az', 'frontmatter']]],
];

const names = (rows: Row[]) => [...new Set(rows.flatMap(([, , , , , aliases]) => aliases.map(([a]) => a)))].sort();
const flat = (m: Map<string, Array<{ slug: string; source_id: string }>>) =>
  Object.fromEntries([...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, v.map((r) => `${r.source_id}:${r.slug}`).sort()]));

const TRUST_SCOPES: Record<string, PageReadScope> = {
  none: {},
  emptyFloor: { minTrust: '' as never },
  curated: { minTrust: 'operator_curated' },
  agent: { minTrust: 'agent_written' },
  any: { minTrust: 'external_untrusted' },
  suppressed: { suppressFlagged: true },
  agentSuppressed: { sourceId: 'default', minTrust: 'agent_written', suppressFlagged: true },
};

describe('engine parity: resolveAliases under the trust floor, the flagged-page filter and excludePrivate', () => {
  parityTest(
    'resolveAliases drops aliases of pages below the floor or flagged, and their titles no longer shadow a derived alias',
    { methods: ['putPage', 'setPageAliases', 'replaceDerivedAliases', 'upsertPageWriteGateReceipt', 'resolveAliases'] },
    async (engine) => {
      await write(engine, TRUST);
      const out: Record<string, Record<string, string[]>> = {};
      for (const [name, scope] of Object.entries(TRUST_SCOPES)) out[name] = flat(await engine.resolveAliases(names(TRUST), scope));
      // Without a floor the frontmatter alias wins and the titles shadow the derived aliases.
      expect(out.none!['shared name']).toEqual(['default:companies/outside']);
      expect(out.none!['low shadow']).toBeUndefined();
      expect(out.none!['flag shadow']).toBeUndefined();
      expect(out.emptyFloor).toEqual(out.none!);
      // Under the agent floor the untrusted page neither answers nor shadows.
      expect(out.agent!['shared name']).toEqual(['default:companies/declared-fallback']);
      expect(out.agent!['low shadow']).toEqual(['default:companies/shadow-target']);
      expect(out.agent!['widget co']).toBeUndefined();
      expect(out.agent!['acme example']).toEqual(['default:companies/acme-example']);
      expect(out.curated!['agent name']).toBeUndefined();
      expect(out.curated!['curated name']).toEqual(['default:companies/curated']);
      // Suppression drops the flagged agent page and its title, not the flagged curated page or another reason family.
      expect(out.suppressed!['flagged name']).toBeUndefined();
      expect(out.suppressed!['flag shadow']).toEqual(['default:companies/flag-target']);
      expect(out.suppressed!['curated flagged name']).toEqual(['default:companies/curated-flagged']);
      expect(out.suppressed!['other flag name']).toEqual(['default:companies/agent-other-flag']);
      expect(out.none!['flagged name']).toEqual(['default:companies/agent-flagged']);
      return out;
    },
  );

  parityTest(
    'resolveAliases under excludePrivate drops aliases of hidden pages, and a hidden title no longer shadows a derived alias',
    { methods: ['putPage', 'setPageAliases', 'replaceDerivedAliases', 'resolveAliases'] },
    async (engine) => {
      await write(engine, PRIVACY);
      const open = flat(await engine.resolveAliases(names(PRIVACY), { excludePrivate: false }));
      const hidden = flat(await engine.resolveAliases(names(PRIVACY), { excludePrivate: true }));
      const scoped = flat(await engine.resolveAliases(names(PRIVACY), { sourceIds: ['default'], excludePrivate: true, requireSafeChunks: true }));
      expect(open['private name']).toEqual(['default:companies/private']);
      expect(open['split name']).toEqual(['default:companies/private-front']);
      expect(open['acme example']).toBeUndefined();
      expect(Object.keys(hidden)).toEqual(['acme example', 'open name', 'origin name', 'split name']);
      expect(hidden['split name']).toEqual(['default:companies/open-declared']);
      expect(hidden['acme example']).toEqual(['default:companies/acme-example']);
      expect(scoped).toEqual(hidden);
      return { open, hidden, scoped };
    },
  );

  parityTest(
    'resolveAliases takes the alias hop\'s options and reads only the page policy; the hop applies the slug excludes itself',
    { methods: ['putPage', 'setPageAliases', 'replaceDerivedAliases', 'resolveAliases'] },
    async (engine) => {
      await write(engine, PRIVACY);
      // What lookupAliasHop passes (search/alias-hop.ts, hybrid/request.ts aliasHopOpts): the identity-tier
      // excludes and the hop switches. isExcludedIdentity applies the excludes after the read.
      const hop = {
        sourceIds: ['default'], excludePrivate: true, requireSafeChunks: true,
        excludeSlugs: ['companies/acme-example'], excludeSlugPrefixes: ['companies/open'], tokenHop: true, qualified: true,
      } as never;
      const out = flat(await engine.resolveAliases(names(PRIVACY), hop));
      expect(out).toEqual(flat(await engine.resolveAliases(names(PRIVACY), { sourceIds: ['default'], excludePrivate: true })));
      expect(out['acme example']).toEqual(['default:companies/acme-example']);
      return out;
    },
  );

  parityTest(
    'resolveAliases under excludePrivate applies a caller\'s reader identity and private-readable grant',
    { methods: ['putPage', 'setPageAliases', 'replaceDerivedAliases', 'resolveAliases'] },
    async (engine) => {
      await write(engine, CALLER);
      const read = (access: Parameters<typeof withCallerAccess>[0]) => withCallerAccess(access,
        async () => flat(await engine.resolveAliases(names(CALLER), { excludePrivate: true })));
      const member = await read({ identity: ALICE, hidePrivate: true });
      const granted = await read({ identity: ALICE, privateReadableSources: ['default'], hidePrivate: true });
      const empty = await read({ identity: [], hidePrivate: true });
      expect(Object.keys(member)).toEqual(['alice name', 'mixed case name', 'open name', 'team name']);
      expect(Object.keys(granted)).toEqual(['alice name', 'mixed case name', 'open name', 'private name', 'private reader name', 'team name']);
      expect(Object.keys(empty)).toEqual(['open name']);
      expect(member['alice name']).toEqual(['default:companies/alice']);
      return { member, granted, empty };
    },
  );

  parityTest(
    'the search alias fan-out resolves an entity by its alias under excludePrivate and a trust floor',
    { methods: ['putPage', 'setPageAliases', 'replaceDerivedAliases', 'upsertPageWriteGateReceipt', 'resolveAliases', 'findPagesByTitles', 'resolveCaseSensitiveAliases'] },
    async (engine) => {
      await write(engine, TRUST);
      const run = (query: string, scope: { excludePrivate: boolean; minTrust?: string }) => withRequestConfigSnapshot(engine,
        () => resolveQueryEntities(engine, query, { sourceId: 'default', ...scope } as never));
      const privateOnly = await run('Acme Example renewal', { excludePrivate: true });
      const floored = await run('Acme Example renewal', { excludePrivate: true, minTrust: 'agent_written' });
      const untrusted = await run('Widget Co renewal', { excludePrivate: true, minTrust: 'agent_written' });
      const unfloored = await run('Widget Co renewal', { excludePrivate: true });
      expect(privateOnly.map((e) => e.pages)).toEqual([[{ slug: 'companies/acme-example', source_id: 'default' }]]);
      expect(floored).toEqual(privateOnly);
      expect(untrusted).toEqual([]);
      expect(unfloored.map((e) => e.pages)).toEqual([[{ slug: 'companies/widget-co', source_id: 'default' }]]);
      return { privateOnly, floored, untrusted, unfloored };
    },
  );

  parityTest(
    'resolveAliases lists mixed-case and non-ASCII aliases, and the pages of one alias, in byte order',
    { methods: ['putPage', 'setPageAliases', 'replaceDerivedAliases', 'resolveAliases'] },
    async (engine) => {
      await write(engine, ORDER);
      const m = await engine.resolveAliases([...names(ORDER)].reverse(), {});
      const listed = [...m.entries()].map(([alias, refs]) => [alias, refs.map((r) => `${r.source_id}:${r.slug}`)]);
      expect(listed).toEqual([
        ['Zulu', ['default:companies/a-c']],
        ['a-z', ['default:companies/alpha']],
        ['alpha', ['default:companies/alpha']],
        ['az', ['default:companies/alpha']],
        ['shared order', ['default:companies/a-c', 'default:companies/ab']],
        ['zulu', ['default:companies/ab']],
        ['ábc', ['default:companies/eclair']],
        ['éclair', ['default:companies/eclair']],
      ]);
      return listed;
    },
  );
});
