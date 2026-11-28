/**
 * Served parity (both routes) for the entity reads a remote caller makes through the real MCP dispatch: `entity_identity_list`
 * and the `context_pack` entity card, which reads an entity's inbound links, world facts, name and alias lookups, core page
 * rows, pending core-edit notices through typed members.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on PGLite, Rust embedded and Rust served (env and config routes) a remote caller (a stdio client with world
 *    rows only, and a member) reads the same entity identity list and the same entity card; the card carries no marker of a
 *    private page or of a page whose readers do not name the caller.
 *  - Regression: these members (listEntityIdentityRows, countInboundLinks, countWorldFacts, listLivePageTitles,
 *    listPageAliasNames, listCorePageRows, listPendingCoreEditNotices) were not in the served typed-read
 *    list, so on a served brain every such remote read was refused (engine_capability_missing) and the card and the identity
 *    list came back empty-handed.
 *  - Why existing coverage misses it: no served case called entity_identity_list or context_pack with an entity.
 *  - Seam: members and pages through createMember, putPage, sealChunks, addLink and insertFacts; the
 *    read is the real dispatchToolCall.
 */
import { afterAll, describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { ALICE, BOB, PURGED_CLAIM, assertAnswered, assertNotRefused, call, installFakeEmbedder, put, removeFakeEmbedder, seedEntityBrain, seedMembers, seedSegmentedPageWithPurge, stable } from '../helpers/served-arg-reads.ts';

const { parityTest } = parityArms(testBackends());

afterAll(() => removeFakeEmbedder());

describe('served parity: the entity identity list and the entity card', () => {
  parityTest('entity_identity_list and context_pack answer the same for a stdio client and a member, and show no hidden page', {
    methods: ['putPage', 'sealChunks', 'addLink', 'insertFacts', 'setConfig',
      'listEntityIdentityRows', 'countInboundLinks', 'countWorldFacts', 'listLivePageTitles', 'listPageAliasNames',
      'listCorePageRows', 'listPendingCoreEditNotices'],
    timeout: 120_000,
  }, async (engine, backend) => {
    installFakeEmbedder();
    await engine.setConfig('memory.core.enabled', 'true');
    await seedMembers(engine, backend);
    await seedEntityBrain(engine);
    await put(engine, 'core/rules', 'note', 'Core rules', 'probemark rules always load', { always_load: true });
    const answers: Record<string, unknown> = {};
    for (const [who, ctx] of [['client', {}], ['member', { stdioMember: BOB }], ['owner', { stdioMember: ALICE }]] as const) {
      answers[`${who}/identity`] = stable(await call(engine, 'entity_identity_list', {}, ctx));
      answers[`${who}/card`] = stable(await call(engine, 'context_pack', { entities: 'Alice Example' }, ctx));
    }
    // The owner reads every page, so only the other callers' answers are checked for markers.
    assertAnswered(Object.fromEntries(Object.entries(answers).filter(([name]) => !name.startsWith('owner/'))), { 'client/card': 'Alice Example' });
    assertNotRefused({ 'owner/identity': answers['owner/identity'], 'owner/card': answers['owner/card'] });
    return answers;
  });

  parityTest('a segmented page whose facts fence holds a globally purged claim reads without it, through entity', {
    methods: ['putPage', 'sealChunks', 'createSegmentedPageShell', 'insertFactPurge', 'normalizeFenceLines', 'listGlobalPurgeWithdrawals'],
    timeout: 120_000,
  }, async (engine, backend) => {
    installFakeEmbedder();
    await seedMembers(engine, backend);
    await seedEntityBrain(engine);
    await seedSegmentedPageWithPurge(engine);
    const answers: Record<string, unknown> = {};
    for (const [who, ctx] of [['client', {}], ['member', { stdioMember: BOB }]] as const) {
      answers[`${who}/entity`] = stable(await call(engine, 'entity', { names: ['Carol Seg'] }, ctx));
    }
    // A lead whose overlay failed is blank (fail closed): the card still quotes the page's lead.
    const lead = 'Carol Seg leads the segmented probemark page.';
    assertAnswered(answers, { 'client/entity': lead, 'member/entity': lead });
    for (const [name, answer] of Object.entries(answers)) expect(JSON.stringify(answer), name).not.toContain(PURGED_CLAIM);
    return answers;
  });
});
