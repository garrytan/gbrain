/**
 * BrainEngine parity for the four reads the enforced member CLI (GBRAIN_ENFORCED_MEMBER, src/cli/enforced-member.ts) makes
 * around a write, and the CLI's own checks built on them.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: (1) readStoredPageLabels answers the stored label columns of a page by source and slug, a soft-deleted page
 *    too, and null for no such page or another source's; readSlugFolderRules answers the rules that cover a slug, with or
 *    without a page there; readMemberPageReadable answers null for no row and else whether the member's read policy
 *    (readers, folder rules it satisfies, privacy) admits the row, soft-deleted rows included; readHiddenPageSlugs answers
 *    each slug that names a page and no page the member reads outside the hidden sources. (2) memberPageView and
 *    namesHiddenPage, which call them, answer the same on every arm. (3) A labelled-only member's page read
 *    answers the same on every arm: true for a page that names the member (or one of its identities, or a folder rule it
 *    satisfies), false for one that does not, null for no row, soft-deleted rows included.
 *  - Regression: each read was an `executeRaw` in enforced-member.ts, which the Rust engine refuses, so every enforced
 *    put stopped with engine_capability_missing before it wrote anything.
 *  - Why existing coverage misses it: test/enforced-member*.serial.test.ts run the CLI on PGLite and Postgres only, and
 *    test/token-member-cli-parity.serial.test.ts runs the puts end to end but with no folder rule, no soft-deleted page and
 *    no second source.
 *  - Seam: none. Real engines; the member record is the one remoteCallerAccess builds for the member.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { checkEnforcedSource, enforcedAccess, memberPageView, namesHiddenPage } from '../../src/cli/enforced-member.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';
import { createMember, createSource, parityArms, restrictFolder } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';

const { parityTest } = parityArms(testBackends());

const MEMBER_RECORD = { identity: ['member:tess-example'], satisfiedRuleIds: [] as string[], hidePrivate: true, restricted: true, owner: false, privateReadableSources: [] as string[], folderCoverage: [] };

/** Pages of every kind the reads tell apart: open, listed, private, soft-deleted, under a rule, and one slug in two sources. */
async function seed(engine: BrainEngine, backend: Parameters<typeof createSource>[1]) {
  await createSource(engine, backend, 'vault');
  await restrictFolder(engine, backend, 'default', 'team-a/', 'rule', { ruleId: 'team-a', readers: ['group:team-a'] });
  const page = (slug: string, frontmatter: Record<string, unknown> = {}, sourceId = 'default') =>
    engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `body of ${slug}`, timeline: '', frontmatter }, { sourceId });
  await page('notes/open');
  await page('notes/listed', { readable_by: ['tess-example'] });
  await page('notes/private', { visibility: 'private' });
  await page('notes/gone', { readable_by: ['tess-example'] });
  await engine.softDeletePage('notes/gone', { sourceId: 'default' });
  await page('team-a/plan');
  await page('notes/open', {}, 'vault');
  await page('notes/twin', { readable_by: ['bob-example'] });
  await page('notes/twin', {}, 'vault');
}

const SLUGS = ['notes/open', 'notes/listed', 'notes/private', 'notes/gone', 'team-a/plan', 'notes/none', 'team-a/new'];

describe('engine parity: the enforced member CLI reads', () => {
  parityTest('the members answer labels as stored, covering rules, a member read of each page and the hidden slugs', {
    methods: ['putPage', 'softDeletePage', 'readStoredPageLabels', 'readSlugFolderRules', 'readMemberPageReadable', 'readHiddenPageSlugs'],
  }, async (engine, backend) => {
    await seed(engine, backend);
    const labels = async (sourceId: string, slug: string) => {
      const row = await engine.readStoredPageLabels(sourceId, slug);
      return row && { ...row, frontmatter: typeof row.frontmatter === 'string' ? JSON.parse(row.frontmatter) : row.frontmatter };
    };
    const readable = async (satisfied: string[], identity = MEMBER_RECORD.identity) => Object.fromEntries(await Promise.all(SLUGS.map(async slug =>
      [slug, await withCallerAccess({ ...MEMBER_RECORD, identity, satisfiedRuleIds: satisfied }, () => engine.readMemberPageReadable('default', slug, identity, satisfied, false))] as const)));
    const hidden = (slugs: string[], sources: string[], satisfied: string[] = []) =>
      withCallerAccess({ ...MEMBER_RECORD, satisfiedRuleIds: satisfied }, () => engine.readHiddenPageSlugs(slugs, sources));
    const out = {
      listed: await labels('default', 'notes/listed'), gone: await labels('default', 'notes/gone'), missing: await labels('default', 'notes/none'), otherSource: await labels('vault', 'notes/listed'),
      rules: [await engine.readSlugFolderRules('default', 'team-a/new'), await engine.readSlugFolderRules('default', 'team-a/plan'), await engine.readSlugFolderRules('default', 'notes/new'),
        await engine.readSlugFolderRules('default', 'team-a'), await engine.readSlugFolderRules('vault', 'team-a/new')],
      tess: await readable([]), tessInGroup: await readable(['default:team-a']), bob: await readable([], ['member:bob-example']), nobody: await readable([], []),
      hidden: await hidden(SLUGS, []), hiddenBySource: await hidden(['notes/open', 'notes/twin', 'notes/listed'], ['vault']), hiddenInGroup: await hidden(SLUGS, [], ['default:team-a']),
      hiddenNone: await hidden([], ['vault']),
    };
    expect(out.listed).toEqual({ type: 'note', frontmatter: { readable_by: ['tess-example'] }, compiled_truth: 'body of notes/listed', timeline: '', body_storage: 'inline', body_bytes: null });
    expect(out.gone).toEqual({ ...out.listed!, compiled_truth: 'body of notes/gone' });
    expect([out.missing, out.otherSource]).toEqual([null, null]);
    expect(out.rules).toEqual([['default:team-a'], ['default:team-a'], null, null, null]);
    expect(out.tess).toEqual({ 'notes/open': true, 'notes/listed': true, 'notes/private': false, 'notes/gone': true, 'team-a/plan': false, 'notes/none': null, 'team-a/new': null });
    expect(out.tessInGroup['team-a/plan']).toBe(true);
    expect([out.bob['notes/listed'], out.bob['notes/open'], out.nobody['notes/listed']]).toEqual([false, true, false]);
    expect(out.hidden).toEqual(['notes/private', 'team-a/plan']);
    expect(out.hiddenBySource).toEqual(['notes/twin']);
    expect(out.hiddenInGroup).toEqual(['notes/private']);
    expect(out.hiddenNone).toEqual([]);
    return out;
  });

  parityTest('memberPageView and namesHiddenPage judge pages, soft-deleted pages and new slugs under folder rules as the member reads them', {
    methods: ['putPage', 'softDeletePage', 'readMemberPageReadable', 'readSlugFolderRules', 'readHiddenPageSlugs', 'readSourceRow'],
  }, async (engine, backend) => {
    await seed(engine, backend);
    await createMember(engine, backend, { id: 'tess-example', groups: ['team-a'] });
    // enforcedAccess keeps one record per engine, so bob's views judge the same page set under bob's identity.
    const out = await withEnv({ GBRAIN_ENFORCED_MEMBER: 'tess-example' }, async () => {
      const tess = await enforcedAccess(engine, 'put');
      const bob = { ...tess, member: 'bob-example', access: { ...tess.access, identity: ['member:bob-example'], satisfiedRuleIds: [] } };
      const viewsOf = async (ea: typeof tess) => Object.fromEntries(await Promise.all([...SLUGS, 'Notes/Listed', 'notes/new'].map(async slug => [slug, await memberPageView(engine, ea, 'default', slug)] as const)));
      const named = (value: unknown) => namesHiddenPage(engine, 'put', value);
      return {
        tess: await viewsOf(tess), bob: await viewsOf(bob), vaultView: await memberPageView(engine, tess, 'vault', 'notes/open'),
        names: [await named({ slug: 'notes/listed' }), await named({ slug: 'notes/private' }), await named({ links: ['notes/open', 'notes/twin'] }), await named({ text: 'notes/private is a sentence' }), await named({}), await named({ slug: 'team-a/plan' })],
      };
    });
    expect(out.tess).toMatchObject({ 'notes/open': 'readable', 'notes/listed': 'readable', 'Notes/Listed': 'readable', 'notes/private': 'hidden', 'notes/gone': 'readable', 'notes/none': 'missing', 'team-a/plan': 'readable', 'team-a/new': 'missing' });
    expect(out.bob).toMatchObject({ 'notes/listed': 'hidden', 'notes/none': 'missing', 'team-a/plan': 'hidden', 'team-a/new': 'hidden', 'notes/new': 'missing' });
    expect(out.names).toEqual([false, true, false, false, false, false]);
    await withEnv({ GBRAIN_ENFORCED_MEMBER: 'tess-example' }, async () => { await checkEnforcedSource(engine, 'put', 'vault'); await checkEnforcedSource(engine, 'put', 'default'); });
    return out;
  });

  // The SQL renderer empties a whole identity or satisfied-rule set when any entry of it is invalid (validIdentity,
  // validQualifiedRuleId), so a member holding one invalid entry reads nothing through that set. The store matches
  // entries one by one, so the Rust members must send the set the SQL applies, not the raw one.
  parityTest('a set with one invalid entry is emptied whole, as the SQL renders it, by both member reads', {
    methods: ['putPage', 'readMemberPageReadable', 'readHiddenPageSlugs'],
  }, async (engine, backend) => {
    await seed(engine, backend);
    const probe = async (identity: string[], satisfied: string[]) => {
      const record = { ...MEMBER_RECORD, identity, satisfiedRuleIds: satisfied };
      const run = <T>(read: () => Promise<T>) => withCallerAccess(record, read).then((value) => ({ value }), (e: { code?: string }) => ({ refused: e.code ?? String(e) }));
      return {
        readable: await run(async () => Object.fromEntries(await Promise.all(['notes/listed', 'team-a/plan', 'notes/open'].map(async slug =>
          [slug, await engine.readMemberPageReadable('default', slug, identity, satisfied, false)] as const)))),
        hidden: await run(() => engine.readHiddenPageSlugs(['notes/listed', 'team-a/plan', 'notes/open'], [])),
      };
    };
    const out = {
      validBoth: await probe(['member:tess-example'], ['default:team-a']),
      badSatisfied: await probe(['member:tess-example'], ['default:team-a', 'invalid']),
      badIdentity: await probe(['member:tess-example', 'not a principal'], []),
    };
    const denied = { readable: { value: { 'notes/listed': true, 'team-a/plan': false, 'notes/open': true } }, hidden: { value: ['team-a/plan'] } };
    expect(out.validBoth).toEqual({ readable: { value: { 'notes/listed': true, 'team-a/plan': true, 'notes/open': true } }, hidden: { value: [] } });
    // One invalid rule id empties the satisfied set: the rule page is denied though the valid id is in the set.
    expect(out.badSatisfied).toEqual(denied);
    // One invalid principal empties the identity: the page naming the member is denied too. (An emptied identity beside valid
    // satisfied rules is a policy the store cannot hold; it refuses, pinned in test/enforced-member-store-refusals.test.ts.)
    expect(out.badIdentity.readable).toEqual({ value: { 'notes/listed': false, 'team-a/plan': false, 'notes/open': true } });
    return out;
  });

  // A labelled-only member reads an existing page only when it names the member or a folder rule it satisfies
  // (labelledOnlyForSql, GBRA-108 design 1): every arm answers the same, the Rust store included (row ec05-1 is closed).
  parityTest('a labelled-only member read of a page names the member, as on the SQL engines', {
    methods: ['putPage', 'softDeletePage', 'readMemberPageReadable'],
  }, async (engine, backend) => {
    await seed(engine, backend);
    const labelled = (slug: string, identity = MEMBER_RECORD.identity, satisfied: string[] = []) =>
      withCallerAccess({ ...MEMBER_RECORD, identity, satisfiedRuleIds: satisfied, labelledOnly: true }, () => engine.readMemberPageReadable('default', slug, identity, satisfied, true));
    const out = {
      // Names the member; names nobody; has no row; a soft-deleted row that names the member; a page that names someone else.
      listed: await labelled('notes/listed'), open: await labelled('notes/open'), none: await labelled('notes/none'),
      gone: await labelled('notes/gone'), twin: await labelled('notes/twin'), otherSource: await engine.readMemberPageReadable('vault', 'notes/listed', MEMBER_RECORD.identity, [], true),
    };
    expect(out).toEqual({ listed: true, open: false, none: null, gone: true, twin: false, otherSource: null });
    return out;
  });

  parityTest('a labelled-only member read names a page through a folder rule or any one of its identities, and the privacy part still applies', {
    methods: ['putPage', 'readMemberPageReadable'],
  }, async (engine, backend) => {
    await seed(engine, backend);
    await engine.putPage('notes/group', { type: 'note', title: 'group', compiled_truth: 'group', timeline: '', frontmatter: { readable_by: ['group:team-a'] } }, { sourceId: 'default' });
    await engine.putPage('notes/secret', { type: 'note', title: 'secret', compiled_truth: 'secret', timeline: '', frontmatter: { readable_by: ['tess-example'], visibility: 'private' } }, { sourceId: 'default' });
    const mixed = ['member:tess-example', 'group:team-a'];
    const labelled = (slug: string, identity: string[], satisfied: string[] = []) =>
      withCallerAccess({ ...MEMBER_RECORD, identity, satisfiedRuleIds: satisfied, labelledOnly: true }, () => engine.readMemberPageReadable('default', slug, identity, satisfied, true));
    const run = (identity: string[], satisfied: string[] = []) => Promise.all(['notes/listed', 'notes/group', 'team-a/plan', 'notes/open', 'notes/secret'].map(async slug => [slug, await labelled(slug, identity, satisfied)] as const)).then(Object.fromEntries);
    const out = {
      member: await run(MEMBER_RECORD.identity), mixedSet: await run(mixed), memberWithRule: await run(MEMBER_RECORD.identity, ['default:team-a']),
      mixedWithRule: await run(mixed, ['default:team-a']), groupOnly: await run(['group:team-a']), nobody: await run([]),
    };
    // The member's own readers, a group of the member, a rule it satisfies: each names it; an open page names nobody; privacy still hides.
    expect(out.member).toEqual({ 'notes/listed': true, 'notes/group': false, 'team-a/plan': false, 'notes/open': false, 'notes/secret': false });
    expect(out.mixedSet).toMatchObject({ 'notes/listed': true, 'notes/group': true, 'notes/open': false, 'notes/secret': false });
    expect(out.memberWithRule['team-a/plan']).toBe(true);
    expect(out.mixedWithRule['team-a/plan']).toBe(true);
    return out;
  });

  parityTest('a labelled-only member read through an identity or rule set holding one invalid entry reads nothing through that set, on every arm', {
    methods: ['putPage', 'readMemberPageReadable'],
  }, async (engine, backend) => {
    await seed(engine, backend);
    const probe = async (identity: string[], satisfied: string[]) => {
      const record = { ...MEMBER_RECORD, identity, satisfiedRuleIds: satisfied, labelledOnly: true };
      return withCallerAccess(record, async () => Object.fromEntries(await Promise.all(['notes/listed', 'team-a/plan', 'notes/open'].map(async slug =>
        [slug, await engine.readMemberPageReadable('default', slug, identity, satisfied, true)] as const)))).then(value => ({ value }), (e: { code?: string }) => ({ refused: e.code ?? String(e) }));
    };
    const out = { validBoth: await probe(['member:tess-example'], ['default:team-a']), badSatisfied: await probe(['member:tess-example'], ['default:team-a', 'invalid']), badIdentity: await probe(['member:tess-example', 'not a principal'], []) };
    expect(out.validBoth).toEqual({ value: { 'notes/listed': true, 'team-a/plan': true, 'notes/open': false } });
    expect(out.badSatisfied).toEqual({ value: { 'notes/listed': true, 'team-a/plan': false, 'notes/open': false } });
    expect(out.badIdentity).toEqual({ value: { 'notes/listed': false, 'team-a/plan': false, 'notes/open': false } });
    return out;
  });

  parityTest('memberPageView judges a labelled-only member by the page it names, a soft-deleted page and a new slug under a rule that lists it', {
    methods: ['putPage', 'softDeletePage', 'readMemberPageReadable', 'readSlugFolderRules'],
  }, async (engine, backend) => {
    await seed(engine, backend);
    await createMember(engine, backend, { id: 'tess-example', groups: ['team-a'] });
    const out = await withEnv({ GBRAIN_ENFORCED_MEMBER: 'tess-example' }, async () => {
      const tess = await enforcedAccess(engine, 'put');
      const labelled = { ...tess, access: { ...tess.access, labelledOnly: true } };
      const viewsOf = async (ea: typeof tess) => Object.fromEntries(await Promise.all([...SLUGS, 'Notes/Listed', 'notes/new'].map(async slug => [slug, await memberPageView(engine, ea, 'default', slug)] as const)));
      return { plain: await viewsOf(tess), labelled: await viewsOf(labelled), vaultView: await memberPageView(engine, labelled, 'vault', 'notes/open') };
    });
    // The labelled-only member narrows the plain view: an open page and a private one turn hidden; a page it is named on stays
    // readable, a soft-deleted one too; a rule page it satisfies is readable; a slug with no row is hidden unless a rule it
    // satisfies covers it (a create names a member only through a rule), so the mixed-case twin of a listed page is hidden.
    expect(out.labelled).toMatchObject({ 'notes/listed': 'readable', 'notes/gone': 'readable', 'team-a/plan': 'readable', 'notes/open': 'hidden', 'notes/private': 'hidden', 'notes/none': 'hidden', 'Notes/Listed': 'hidden', 'team-a/new': 'missing' });
    expect(out.vaultView).toBe('hidden');
    return out;
  });
});
