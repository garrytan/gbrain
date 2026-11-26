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
 *    namesHiddenPage, which call them, answer the same on every arm. (3) A labelled-only member's page read is not served
 *    on Rust yet: it stops on the typed refusal before any read (the stop pin of row ec05-1).
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

  // A labelled-only member reads an existing page only when it names the member (labelledOnlyForSql); the store does not
  // model that conjunct yet, so the Rust member refuses before any read (row ec05-1, test/rust-stop-pins/ec05-enforced-member.tsv).
  parityTest('a labelled-only member read of a page names the member on the SQL engines and stops on Rust', {
    methods: ['putPage', 'readMemberPageReadable'],
  }, async (engine, backend) => {
    await seed(engine, backend);
    const labelled = (slug: string) => withCallerAccess({ ...MEMBER_RECORD, labelledOnly: true }, () => engine.readMemberPageReadable('default', slug, MEMBER_RECORD.identity, [], true));
    const out = { listed: await labelled('notes/listed'), open: await labelled('notes/open'), none: await labelled('notes/none') };
    expect(out).toEqual({ listed: true, open: false, none: null });
    return out;
  });
});
