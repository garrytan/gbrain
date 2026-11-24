/**
 * BrainEngine parity — the folder-rule and member reads list text keys in byte order on every engine and locale.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: listAccessRules (by rule id), listAccessCoverage (by reason, prefix), listAccessPrefixSlugs (by slug, for
 *    one prefix and several), listAppliedPolicyRevisions (by source id), readFolderAccess coverage (by source id,
 *    prefix), readAccessMembers (by id, each member's groups by group id), readLiveMember and readAudiencePrincipals
 *    (groups by group id), listAudienceAccessMembers (by id), readAccessGroups (by id, each group's members by member
 *    id), listPagesNamingReader (by source id, slug, at most 51), listActiveAccessMembers and the serves view's
 *    enabled members (by id), and the raw-SQL caller copies (a credential's verified member groups, an attested
 *    actor's linked groups, labelled-only member ids, doctor's audience members, open pages' source fallback) return
 *    the same order on every engine arm (PGLite
 *    always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1): byte order, as PGLite and the Rust
 *    store sort. A rulebook digest does not depend on the order the database returns rules in, so an identical
 *    rulebook proposed again in another order is unchanged on every arm, with no new revision and nothing held.
 *  - Regression: an en_US Postgres sorted these keys by its locale, which skips punctuation (`ab` before `a-z`), so
 *    `access rule list`, `access member list`, whoami's applied revisions and the pages-naming cut at 51 came back in
 *    another order than on PGLite and Rust brains.
 *  - Why existing coverage misses it: the cases used ids that sort the same in every locale, and CI's Postgres runs
 *    in C.UTF-8. Every case here mixes `a-z`, `ab`, `a.b` and `a_b`; run it against an en_US Postgres to see it fail.
 *  - Seam: none. Folder rules come from policy.ts; pending prefixes and policy revisions from the restrictFolder and
 *    seedAccessPolicy fixtures.
 */
import { describe, expect } from 'bun:test';
import { createSource, parityArms, restrictFolder, seedAccessPolicy } from './harness.ts';
import { rulebookDigest, type FolderRule } from '../../src/core/access/folder-rules.ts';
import { listRevisions, policyStatus, proposeRevision } from '../../src/core/access/policy.ts';
import type { AccessMemberInsert } from '../../src/core/engine-sql/access-members.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { brainServes } from '../../src/core/access/serves.ts';
import { tokenMemberBinding } from '../../src/core/access/token-binding.ts';
import { linkedMember } from '../../src/core/access/actor.ts';
import { labelledOnlyMemberIds } from '../../src/core/access/labelled-only.ts';
import { openPages } from '../../src/core/access/open-pages.ts';
import { accessLineageEntry } from '../../src/commands/doctor/checks/access-lineage.ts';
import type { DoctorContext } from '../../src/commands/doctor/context.ts';
import { sqlQueryForEngine } from '../../src/core/sql-query.ts';

const { parityTest } = parityArms(testBackends());

/** Ids that sort differently by byte and by an en_US collation (which skips the punctuation). */
const MIXED = ['ab', 'a_b', 'a-z', 'a.b'];
/** MIXED in byte order. */
const BYTES = ['a-z', 'a.b', 'a_b', 'ab'];
const GROUPS = ['gb', 'g_b', 'g-z', 'g.b'];
const GROUP_BYTES = ['g-z', 'g.b', 'g_b', 'gb'];
/** Two sources whose ids sort differently by byte and by en_US. */
const SOURCES = ['ab', 'a-z'];

const member = (id: string, extra: Partial<AccessMemberInsert> = {}): AccessMemberInsert =>
  ({ id, displayName: null, email: null, kind: 'person', groups: [], bindTokenId: null, ...extra });

describe('access reads sort text keys by byte', () => {
  parityTest('listAccessRules lists rules by byte id, and a rulebook proposed again in another order is unchanged', {
    methods: ['listAccessRules', 'applyAccessRuleChanges', 'insertAccessPolicyRevision', 'readAccessPolicyRevisions'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'work');
    const rules: FolderRule[] = MIXED.map(id => ({ id, prefix: `${id}/`, readable_by: ['member:alice-example'] }));
    await proposeRevision(engine, 'work', rules, { origin: 'cli', store: 'database' });
    const listed = (await engine.listAccessRules('work')).map(r => r.rule_id);
    const status = await policyStatus(engine, 'work');
    const again = await proposeRevision(engine, 'work', [...rules].reverse(), { origin: 'cli' });
    const out = {
      listed, digestMatches: status.applied_digest === rulebookDigest(rules), digest: status.applied_digest,
      again: { state: again.state, change_kind: again.change_kind, held: again.held, revision: again.revision },
      revisions: (await listRevisions(engine, 'work')).length,
    };
    expect(out).toMatchObject({ listed: BYTES, digestMatches: true, again: { state: 'unchanged', change_kind: 'unchanged', held: [], revision: 1 }, revisions: 1 });
    return out;
  });

  parityTest('pending prefixes, folder coverage, prefix slugs and applied revisions list by byte', {
    methods: ['listAccessCoverage', 'readFolderAccess', 'listAccessPrefixSlugs', 'listAppliedPolicyRevisions', 'putPage'],
  }, async (engine, backend) => {
    for (const source of SOURCES) {
      await createSource(engine, backend, source);
      await seedAccessPolicy(engine, backend, source, [{ revision: 1, applied: true }]);
      for (const id of MIXED) {
        await restrictFolder(engine, backend, source, `${id}/`, 'pending');
        await engine.putPage(`${id}/p`, { type: 'note', title: id, compiled_truth: `body of ${id}`, timeline: '' }, { sourceId: source });
      }
    }
    const out = {
      coverage: (await engine.listAccessCoverage('ab')).map(c => `${c.reason}:${c.prefix}`),
      folderCoverage: (await engine.readFolderAccess([])).coverage.map(c => `${c.source_id}:${c.prefix}`),
      oneSlug: await engine.listAccessPrefixSlugs('ab', 'a'),
      slugs: await engine.listAccessPrefixSlugs('ab', MIXED.map(id => `${id}/`)),
      revisions: (await engine.listAppliedPolicyRevisions()).map(r => r.source_id),
    };
    expect(out).toEqual({
      coverage: BYTES.map(id => `pending:${id}/`),
      folderCoverage: ['a-z', 'ab'].flatMap(s => BYTES.map(id => `${s}:${id}/`)),
      oneSlug: BYTES.map(id => `${id}/p`), slugs: BYTES.map(id => `${id}/p`),
      revisions: ['a-z', 'ab'],
    });
    return out;
  });

  parityTest('member, audience and group reads list ids and group ids by byte', {
    methods: ['insertAccessMember', 'readAccessMembers', 'readLiveMember', 'readAudiencePrincipals', 'listAudienceAccessMembers', 'readAccessGroups'],
  }, async (engine) => {
    for (const id of MIXED) await engine.insertAccessMember(member(id, { groups: GROUPS }));
    for (const id of MIXED) await engine.insertAccessMember(member(`x${id}`, { kind: 'audience' }));
    const principals = await engine.readAudiencePrincipals(MIXED, []);
    const out = {
      live: (await engine.readAccessMembers({ includeRemoved: false })).map(m => [m.id, m.groups]),
      all: (await engine.readAccessMembers({ includeRemoved: true })).map(m => m.id),
      one: (await engine.readAccessMembers({ id: 'a-z' })).map(m => m.groups),
      liveMember: (await engine.readLiveMember('member', 'a.b'))?.groups,
      principals: [...principals.members].sort((a, b) => (a.id < b.id ? -1 : 1)).map(m => [m.id, m.groups]),
      audience: await engine.listAudienceAccessMembers(),
      groups: (await engine.readAccessGroups(null)).map(g => [g.id, g.members]),
      group: (await engine.readAccessGroups('g.b')).map(g => g.members),
    };
    const people = BYTES.map(id => [id, GROUP_BYTES]);
    expect(out).toEqual({
      live: [...people, ...BYTES.map(id => [`x${id}`, []])],
      all: [...BYTES, ...BYTES.map(id => `x${id}`)],
      one: [GROUP_BYTES], liveMember: GROUP_BYTES, principals: people,
      audience: BYTES.map(id => `x${id}`),
      groups: GROUP_BYTES.map(g => [g, BYTES]), group: [BYTES],
    });
    return out;
  });

  parityTest('listPagesNamingReader lists the pages by byte source id and slug', { methods: ['listPagesNamingReader', 'putPage'] }, async (engine, backend) => {
    for (const source of SOURCES) {
      await createSource(engine, backend, source);
      for (const id of MIXED) {
        await engine.putPage(`${id}/p`, { type: 'note', title: id, compiled_truth: `body of ${id}`, frontmatter: { readable_by: ['member:alice-example'] } }, { sourceId: source });
      }
    }
    const out = (await engine.listPagesNamingReader('member:alice-example')).map(p => `${p.source_id}:${p.slug}`);
    expect(out).toEqual(['a-z', 'ab'].flatMap(s => BYTES.map(id => `${s}:${id}/p`)));
    const live = (await engine.listPagesNamingReader('member:alice-example', { live: true })).map(p => `${p.source_id}:${p.slug}`);
    expect(live).toEqual(out);
    return { out, live };
  });

  parityTest('listActiveAccessMembers and the serves view list the enabled members by byte id', {
    methods: ['insertAccessMember', 'listActiveAccessMembers', 'getConfig'],
  }, async (engine) => {
    for (const id of MIXED) await engine.insertAccessMember(member(id));
    const out = { active: await engine.listActiveAccessMembers(), serves: (await brainServes(engine)).enabled_members };
    expect(out).toEqual({ active: BYTES, serves: BYTES });
    return out;
  });

  // The member flags and the link are written through the typed writes `gbrain access member` uses; the token binding
  // check reads the member through the engine, as its callers pass it.
  parityTest('the raw-SQL caller copies list member groups, member ids and sources by byte', {
    methods: ['insertAccessMember', 'setAccessMemberLabelledOnly', 'insertAccessMemberLink', 'readAccessMembers'],
  }, async (engine, backend) => {
    for (const source of SOURCES) await createSource(engine, backend, source);
    for (const id of MIXED) await engine.insertAccessMember(member(id, { groups: GROUPS }));
    for (const id of MIXED) await engine.insertAccessMember(member(`x${id}`, { kind: 'audience' }));
    for (const id of MIXED) await engine.setAccessMemberLabelledOnly(id, true);
    await engine.insertAccessMemberLink('qm', 'ext-1', 'ab');
    const checks = await accessLineageEntry.run({ engine } as unknown as DoctorContext) as Array<{ name: string; details?: { members?: string[] } }>;
    const out = {
      verified: (await tokenMemberBinding(sqlQueryForEngine(engine), { member_id: 'ab' }, null, engine)).member?.groups,
      linked: (await linkedMember(engine, 'qm', 'ext-1'))?.groups,
      labelledOnly: await labelledOnlyMemberIds(engine),
      audience: checks.find(c => c.name === 'access_audience_members')?.details?.members,
      sources: (await openPages(engine)).sources,
    };
    expect(out).toEqual({
      verified: GROUP_BYTES, linked: GROUP_BYTES, labelledOnly: BYTES, audience: BYTES.map(id => `x${id}`),
      sources: [...SOURCES, 'default'].sort(),
    });
    return out;
  });
});
