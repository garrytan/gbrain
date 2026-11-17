/**
 * GST-2951: the brain owner's own remote agents read private facts through find_trajectory, get_write_attribution,
 * ontology_get, ontology_conflicts and volunteer_chronicle, as they already do through recall, query and think
 * (GST-2089, access-owner-reads.test.ts).
 *
 * 1. Protects: a credential bound to the member access.owner_member names gets the owner's private facts from each of
 *    those operations. Every other caller reads exactly what it read before: another member, a labelled-only member, an
 *    unbound token, a call with no credential, and the owner's credential speaking for an audience of several get
 *    world-only facts; a credential with the private-facts grant keeps it on find_trajectory (the one of these operations
 *    that honours it) and gains nothing on the others. Page rules stay: the owner reads no fact taken from another
 *    person's readable_by page, and no caller reads a withdrawn fact.
 * 2. Fails when: these operations decide fact visibility from the raw remote flag again (the owner gets world-only
 *    facts), or a non-owner caller reads a private fact.
 * 3. Existing coverage: access-owner-reads pins recall, query, hot memory, delta, context_pack and think's trajectory;
 *    none of these five operations is in it.
 * 4. Real seams: tokens minted by the token service and verified by the serve --http verifier, dispatched through MCP
 *    dispatch as serve-http-mcp does (remote: true), on a repo-less brain; PGLite, and Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { noGrantFederatedScope } from '../src/core/source-resolver.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { bindCredential } from '../src/core/access/members.ts';
import { setMemberLabelledOnly } from '../src/core/access/labelled-only.ts';
import { parseRescopeTokenArgs, rescopeLegacyToken } from '../src/core/grants/legacy-token.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { readsUnscopedOnPurpose } from './helpers/reads-unscoped.ts';

const SRC = 'own-src';
const OWNER = 'owner-example';
const ENTITY = 'people/dana-example';
const WORLD_PAGE = 'notes/open-ledger';
const BOBS_PAGE = 'notes/bob-ledger';
/** Private facts the owner reads and no other caller does. */
const OWN = { trajectory: 'canaryowntrajpoint', ontology: 'canaryownontology' } as const;
/** Facts nobody remote reads: one taken from another person's readable_by page, and withdrawn ones. */
const BOBS = { trajectory: 'canarybobtrajpoint', ontology: 'canarybobontology' } as const;
const WITHDRAWN = { trajectory: 'canarygonetrajpoint', ontology: 'canarygoneontology' } as const;
/** A private fact on a world page: the private-facts grant admits it. */
const GRANTED = 'canarygrantedtrajpoint';
const WORLD = 'canaryworldtrajpoint';
/** Private facts taken from a private page the owner reads (visibility: private, no readers). */
const OWNERS_PAGE = 'notes/owner-ledger';
const OWN_PAGE = { trajectory: 'canaryownpagetrajpoint', ontology: 'canaryownpageontology' } as const;
/** A newer private observation from a diary page and the older one beside it that a remote reader still gets. */
const DIARY = 'canarydiarysleep';
const BEHIND_DIARY = 'canaryvisiblesleep';

type Surface = 'find_trajectory' | 'ontology_get' | 'ontology_conflicts' | 'volunteer_chronicle';
const SURFACES: Surface[] = ['find_trajectory', 'ontology_get', 'ontology_conflicts', 'volunteer_chronicle'];
const READS: Record<Surface, [string, Record<string, unknown>]> = {
  find_trajectory: ['find_trajectory', { entity_slug: ENTITY }],
  ontology_get: ['ontology_get', { entity: ENTITY }],
  ontology_conflicts: ['ontology_conflicts', {}],
  volunteer_chronicle: ['volunteer_chronicle', { entities: ENTITY }],
};
const CANARY: Record<Surface, keyof typeof OWN> = { find_trajectory: 'trajectory', ontology_get: 'ontology', ontology_conflicts: 'ontology', volunteer_chronicle: 'ontology' };

for (const kind of testBackends()) {
  describe(`owner fact operations (${kind}, repo-less)`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const tokens: Record<string, string> = {};
    const ids: Record<string, number> = {};
    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });

    /** One MCP call as serve --http makes it; `anonymous` carries no credential at all. */
    async function call(who: string, op: string, params: Record<string, unknown>, header?: string): Promise<{ isError: boolean; text: string }> {
      __resetPrivateVisibilityCacheForTests();
      if (who === 'anonymous') {
        const out = await dispatchToolCall(engine, op, { ...params }, { remote: true, transport: 'http', sourceId: SRC, takesHoldersAllowList: ['world'] });
        return { isError: out.isError === true, text: out.content.map(c => c.text).join('\n') };
      }
      const auth = await provider().verifyAccessToken(tokens[who]!) as unknown as AuthInfo;
      const sourceId = auth.sourceId ?? 'default';
      const localFederated = await noGrantFederatedScope(engine, auth.hasSourceGrant, sourceId);
      const out = await dispatchToolCall(engine, op, { ...params }, {
        remote: true, transport: 'http', auth, sourceId, takesHoldersAllowList: auth.takesHoldersAllowList ?? ['world'],
        ...(localFederated ? { localFederatedSourceIds: localFederated } : {}), ...(header ? { onBehalfOf: { header } } : {}),
      });
      return { isError: out.isError === true, text: out.content.map(c => c.text).join('\n') };
    }

    /** The surfaces on which `who` reads the private fact of `set`. */
    async function seenBy(who: string, set: Record<keyof typeof OWN, string>, header?: string): Promise<Surface[]> {
      const seen: Surface[] = [];
      for (const surface of SURFACES) {
        const [op, params] = READS[surface];
        const out = await call(who, op, params, header);
        if (out.isError) throw new Error(`${who} ${op}: ${out.text}`);
        if (out.text.includes(set[CANARY[surface]])) seen.push(surface);
      }
      return seen;
    }

    /** `who` (an admin credential) asks for the write attribution of fact `id`: true, or the refusal's code. */
    async function attributes(who: string, id: number, header?: string): Promise<true | string> {
      const out = await call(who, 'get_write_attribution', { slug: ENTITY, fact: id }, header);
      return out.isError ? String((JSON.parse(out.text) as { code?: unknown }).code) : true;
    }

    const insertFact = async (canary: string, visibility: 'private' | 'world', provenance: string | null, validFrom: string) => {
      const [row] = await engine.executeRaw<{ id: number | string }>(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, valid_from, source, event_type, source_markdown_slug)
        VALUES ($1, $2, $3, 'event', $4, $5, 'fixture', 'job_change', $6) RETURNING id`, [SRC, ENTITY, `Dana switched jobs ${canary}`, visibility, validFrom, provenance]);
      return Number(row!.id);
    };
    const insertObservation = async (dimension: string, value: string, provenance: string, validFrom: string) => {
      const [row] = await engine.executeRaw<{ id: number | string }>(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, dimension, value, value_hash, confidence, source, source_markdown_slug, valid_from)
        VALUES ($1, $2, $3, 'fact', 'private', $4, $5, md5($5), 0.8, $6, $6, $7) RETURNING id`, [SRC, ENTITY, `${dimension}: ${value}`, dimension, value, provenance, validFrom]);
      return Number(row!.id);
    };

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      __resetPrivateVisibilityCacheForTests();
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SRC]);
      const page = (title: string, fm: string[] = []) => ['---', 'type: note', `title: ${title}`, ...fm, '---', `# ${title}`, '', 'Ledger notes.'].join('\n');
      await importFromContent(engine, ENTITY, ['---', 'type: person', 'title: Dana Example', '---', '# Dana Example', '', 'Dana is a founder.'].join('\n'), { sourceId: SRC });
      await importFromContent(engine, WORLD_PAGE, page('Open ledger'), { sourceId: SRC });
      await importFromContent(engine, BOBS_PAGE, page('Bob ledger', ['readable_by: [bob-example]']), { sourceId: SRC });
      await importFromContent(engine, OWNERS_PAGE, page('Owner ledger', ['visibility: private']), { sourceId: SRC });

      ids.own = await insertFact(OWN.trajectory, 'private', null, '2026-05-01T00:00:00Z');
      ids.bobs = await insertFact(BOBS.trajectory, 'private', BOBS_PAGE, '2026-05-02T00:00:00Z');
      ids.withdrawn = await insertFact(WITHDRAWN.trajectory, 'private', null, '2026-05-03T00:00:00Z');
      ids.withdrawnWorld = await insertFact('canarygoneworldpoint', 'world', null, '2026-05-03T00:00:00Z');
      ids.granted = await insertFact(GRANTED, 'private', WORLD_PAGE, '2026-05-04T00:00:00Z');
      ids.world = await insertFact(WORLD, 'world', null, '2026-05-05T00:00:00Z');
      // Two current values from two provenances: ontology_conflicts reports the pair.
      await insertObservation('risk_tolerance', `low ${OWN.ontology}`, 'notes/source-a-example', '2026-01-01T00:00:00Z');
      await insertObservation('risk_tolerance', `high ${OWN.ontology}`, 'notes/source-b-example', '2026-02-01T00:00:00Z');
      await insertObservation('mood', `calm ${BOBS.ontology}`, BOBS_PAGE, '2026-02-01T00:00:00Z');
      await insertObservation('mood', 'tense', 'notes/source-c-example', '2026-01-01T00:00:00Z');
      ids.withdrawnObservation = await insertObservation('status', `gone ${WITHDRAWN.ontology}`, 'notes/source-d-example', '2026-02-01T00:00:00Z');
      ids.ownPage = await insertFact(OWN_PAGE.trajectory, 'private', OWNERS_PAGE, '2026-05-06T00:00:00Z');
      await insertObservation('focus', `climbing ${OWN_PAGE.ontology}`, OWNERS_PAGE, '2026-02-01T00:00:00Z');
      await insertObservation('focus', 'running', 'notes/source-e-example', '2026-01-01T00:00:00Z');
      await insertObservation('sleep', `early ${BEHIND_DIARY}`, 'notes/source-f-example', '2026-01-01T00:00:00Z');
      await insertObservation('sleep', `late ${DIARY}`, 'life/diary/2026-02-01', '2026-02-01T00:00:00Z');
      for (const id of [ids.withdrawn, ids.withdrawnWorld, ids.withdrawnObservation]) {
        const forgot = await dispatchToolCall(engine, 'forget_fact', { id }, { remote: false, sourceId: SRC });
        if (forgot.isError) throw new Error(`fixture forget: ${forgot.content.map(c => c.text).join(' ')}`);
      }

      for (const id of [OWNER, 'bob-example', 'lab-example']) await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1)', [id]);
      await setMemberLabelledOnly(engine, 'lab-example', true, { remote: false });
      const mint = async (name: string, scopes: string[], member?: string, mayActFor?: string[]) => {
        const minted = await mintLegacyToken(engine, { name, scopes, takesHolders: ['world'], sourceGrant: [SRC] });
        tokens[name] = minted.token;
        if (member) await bindCredential(engine, { kind: 'token', id: minted.id }, { member, ...(mayActFor ? { mayActFor } : {}) });
        else await readsUnscopedOnPurpose(engine, minted.id);
      };
      const audience = [`member:${OWNER}`, 'member:bob-example'];
      for (const [suffix, scopes] of [['', ['read']], ['-admin', ['read', 'admin']]] as const) {
        await mint(`owner${suffix}`, [...scopes], OWNER, audience);
        await mint(`delegate${suffix}`, [...scopes], OWNER);
        await mint(`bob${suffix}`, [...scopes], 'bob-example');
        await mint(`lab${suffix}`, [...scopes], 'lab-example');
        await mint(`unbound${suffix}`, [...scopes]);
        await mint(`granted${suffix}`, [...scopes]);
        await rescopeLegacyToken(engine, parseRescopeTokenArgs([`granted${suffix}`, '--private-facts', 'granted-sources']));
      }
      await setOwner(engine, OWNER);
    }, 240_000);

    afterAll(async () => { await close?.(); }, 60_000);

    const AUDIENCE = `member:${OWNER},member:bob-example`;

    test('fixture control: a trusted local caller reads every private fact but the withdrawn ones on every surface', async () => {
      for (const surface of SURFACES) {
        const [op, params] = READS[surface];
        const text = (await dispatchToolCall(engine, op, params, { remote: false, sourceId: SRC })).content.map(c => c.text).join('\n');
        const k = CANARY[surface];
        expect({ surface, own: text.includes(OWN[k]), bobs: text.includes(BOBS[k]), withdrawn: text.includes(WITHDRAWN[k]) }).toEqual({ surface, own: true, bobs: true, withdrawn: false });
      }
    }, 120_000);

    test('the owner and a delegate bound to the owner read their private facts on every surface', async () => {
      for (const who of ['owner', 'delegate']) expect({ who, seen: await seenBy(who, OWN) }).toEqual({ who, seen: SURFACES });
      expect(await seenBy('owner', OWN, `member:${OWNER}`)).toEqual(SURFACES);
    }, 240_000);

    test('the owner\'s admin credential gets the write attribution of a private fact', async () => {
      for (const who of ['owner-admin', 'delegate-admin']) expect({ who, attributed: await attributes(who, ids.own!) }).toEqual({ who, attributed: true });
    }, 120_000);

    test('another member, a labelled-only member, an unbound token, no credential and the owner for an audience read no private fact', async () => {
      for (const who of ['bob', 'lab', 'unbound', 'anonymous']) expect({ who, seen: await seenBy(who, OWN) }).toEqual({ who, seen: [] });
      expect(await seenBy('owner', OWN, AUDIENCE)).toEqual([]);
      for (const who of ['bob-admin', 'unbound-admin', 'granted-admin']) expect({ who, attributed: await attributes(who, ids.own!) }).toEqual({ who, attributed: 'fact_not_found' });
      // A labelled-only member reads no page that does not name it, so the entity page itself reads as missing.
      expect(await attributes('lab-admin', ids.own!)).toBe('page_not_found');
      expect(await attributes('owner-admin', ids.own!, AUDIENCE)).toBe('fact_not_found');
      expect((await call('bob', 'find_trajectory', { entity_slug: ENTITY })).text).toContain(WORLD);
      expect(await attributes('bob-admin', ids.world!)).toBe(true);
    }, 240_000);

    test('the private-facts grant still admits a private fact on a world page to find_trajectory, and nothing else changes for it', async () => {
      const trajectory = (await call('granted', 'find_trajectory', { entity_slug: ENTITY })).text;
      expect({ granted: trajectory.includes(GRANTED), own: trajectory.includes(OWN.trajectory) }).toEqual({ granted: true, own: false });
      expect(await seenBy('granted', OWN)).toEqual([]);
      for (const who of ['bob', 'unbound']) expect({ who, granted: (await call(who, 'find_trajectory', { entity_slug: ENTITY })).text.includes(GRANTED) }).toEqual({ who, granted: false });
    }, 120_000);

    test('member access stays mandatory for the owner: no fact taken from another person\'s readable_by page', async () => {
      expect(await seenBy('owner', BOBS)).toEqual([]);
      expect(await attributes('owner-admin', ids.bobs!)).toBe('fact_not_found');
    }, 240_000);

    test('the owner reads private facts taken from a private page it reads, on every surface and in write attribution', async () => {
      for (const who of ['owner', 'delegate']) expect({ who, seen: await seenBy(who, OWN_PAGE) }).toEqual({ who, seen: SURFACES });
      expect(await attributes('owner-admin', ids.ownPage!)).toBe(true);
      for (const who of ['bob', 'unbound']) expect({ who, seen: await seenBy(who, OWN_PAGE) }).toEqual({ who, seen: [] });
      expect(await seenBy('owner', OWN_PAGE, AUDIENCE)).toEqual([]);
      expect(await attributes('bob-admin', ids.ownPage!)).toBe('fact_not_found');
    }, 240_000);

    test('a newer diary observation neither reaches the owner nor hides the older value behind it', async () => {
      for (const who of ['owner', 'delegate']) {
        for (const [op, params] of [READS.ontology_get, READS.volunteer_chronicle]) {
          const text = (await call(who, op, params)).text;
          expect({ who, op, behind: text.includes(BEHIND_DIARY), diary: text.includes(DIARY) }).toEqual({ who, op, behind: true, diary: false });
        }
        expect((await call(who, ...READS.ontology_conflicts)).text).not.toContain(DIARY);
      }
      const local = (await dispatchToolCall(engine, 'ontology_get', READS.ontology_get[1], { remote: false, sourceId: SRC })).content.map(c => c.text).join('\n');
      expect(local).toContain(DIARY);
    }, 240_000);

    test('no caller reads a withdrawn fact', async () => {
      for (const who of ['owner', 'delegate', 'bob', 'unbound']) expect({ who, seen: await seenBy(who, WITHDRAWN) }).toEqual({ who, seen: [] });
    }, 240_000);

    test('write attribution keeps its audit reach: it names who wrote a withdrawn row, never its text, for the owner as for any admin on a world row', async () => {
      const owner = await call('owner-admin', 'get_write_attribution', { slug: ENTITY, fact: ids.withdrawn! });
      expect({ isError: owner.isError, text: owner.text.includes(WITHDRAWN.trajectory) }).toEqual({ isError: false, text: false });
      expect(await attributes('bob-admin', ids.withdrawnWorld!)).toBe(true);
      expect(await attributes('bob-admin', ids.withdrawn!)).toBe('fact_not_found');
    }, 120_000);
  });
}
