/**
 * BrainEngine parity — a labelled-only member's remote page writes, through the MCP dispatch a bound legacy token drives.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a labelled-only member (access_members.labelled_only) reads only pages that name it, so its remote put_page
 *    or capture may not rewrite an open page that does not name it, and may not create a page that does not name it. The
 *    write is refused on every arm and nothing is written: the body, the version count and the page list stay as they were.
 *    A rewrite of a page is refused with page_not_found, the same bytes on every arm, unless the page names the member (its
 *    readable_by holds the member or one of its groups) or a folder rule the member satisfies is stamped on it.
 *  - Regression: the Rust opening probe (readWriteVisibilityProbe) always answered `any_labelled: false` and never read
 *    access_members, so the write check treated the writer as unlabelled and returned early for a page open to everyone. Once the
 *    probe answered truly, the check's raw read of the owner id refused every remote writer on Rust (the owner and ordinary members
 *    too, also after the labelled-only member was disabled or removed), and the Rust store did not serve the labelled-only writer
 *    policy, so the rewrite ended on engine_capability_missing instead of page_not_found.
 *  - Links: a successful rewrite whose body mentions other pages gets mention edges only to the pages the labelled-only writer can read (a page
 *    that names the member or a group it is in, or sits under a folder rule that lists it), not to an open page or a page naming another member.
 *  - Pending folder prefix: not pinned beyond the shapes case below. A page under a pending prefix is hidden by the member-access part of the
 *    writer's policy before the labelled-only part is judged (private-visibility.ts folderRulesAllowedSql's coverageSql), so the labelled-only
 *    judgement never meets a page under a pending prefix through a write.
 *  - Why existing coverage misses it: the labelled-only write cases (test/access-labelled-only-*.test.ts) run on PGLite and
 *    Postgres only; the parity cases of the grant set and read it, and the plain member's write case uses an unlabelled member
 *    on a brain with none.
 *  - Seam: none. The grant through setMemberLabelledOnly, the token through mintLegacyToken and bindCredential, the real bearer
 *    check and dispatchToolCall. A refusal is returned as a value: the harness counts a thrown typed refusal as a pass.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { createSource, parityArms, resetArm, restrictFolder, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { addGroup, addMember, bindCredential, disableMember, removeMember } from '../../src/core/access/members.ts';
import { proposeRevision } from '../../src/core/access/policy.ts';
import { setMemberLabelledOnly } from '../../src/core/access/labelled-only.ts';
import { setOwner } from '../../src/core/access/owner.ts';
import { mintLegacyToken } from '../../src/core/token-mint.ts';
import { GBrainOAuthProvider } from '../../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../../src/core/sql-query.ts';
import { runPersistenceEffects } from '../../src/core/persistence/effects.ts';
import { localHostId } from '../../src/core/persistence/identity.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import type { AuthInfo } from '../../src/core/ops/contract.ts';

const { arms, parityTest } = parityArms(testBackends());
const SRC = 'work';
const OWNER = 'alice-example';
const LABELLED = 'carol-example';
const PLAIN = 'bob-example';

/** `value` with the ids and times that differ on every run (uuids, ISO timestamps) replaced, so arms compare by content. */
function stable<T>(value: T): T {
  return JSON.parse(JSON.stringify(value).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>').replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g, '<time>')) as T;
}

async function seed(engine: BrainEngine, backend: ParityBackend): Promise<void> {
  await createSource(engine, backend, SRC);
  await addMember(engine, OWNER);
  await setOwner(engine, OWNER);
  await addMember(engine, PLAIN);
  await addMember(engine, LABELLED);
  await setMemberLabelledOnly(engine, LABELLED, true, { remote: false });
}

/** What a remote write answered: 'written', or the whole error body it was refused with (code, message, fix). */
type WriteOutcome = 'written' | Record<string, unknown>;

/** `member`'s remote write through the MCP dispatch, on a token bound to it: the dispatch result, or the typed refusal it threw. */
async function memberDispatch(engine: BrainEngine, member: string, operation: 'put_page' | 'capture', params: Record<string, unknown>, credential?: { id?: string }): Promise<Awaited<ReturnType<typeof dispatchToolCall>> | { code: string; thrown: true }> {
  const minted = await mintLegacyToken(engine, { name: `k-${member}-${String(params.slug)}`, scopes: ['read', 'write'], takesHolders: ['world'], sourceGrant: [SRC] });
  await bindCredential(engine, { kind: 'token', id: minted.id }, { member });
  if (credential) credential.id = minted.id;
  const auth = await new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), engine }).verifyAccessToken(minted.token) as unknown as AuthInfo;
  return dispatchToolCall(engine, operation, params, { remote: true, transport: 'http', auth, sourceId: SRC, takesHoldersAllowList: ['world'] })
    .catch((e: { code?: string }) => ({ code: String(e.code), thrown: true as const }));
}

/** `member`'s remote write through the MCP dispatch, on a token bound to it; a refusal is returned as a value. */
async function memberWriteOutcome(engine: BrainEngine, member: string, operation: 'put_page' | 'capture', params: Record<string, unknown>): Promise<WriteOutcome> {
  const out = await memberDispatch(engine, member, operation, params);
  if ('thrown' in out) return out;
  return out.isError ? JSON.parse(out.content.map(c => c.text).join('')) as Record<string, unknown> : 'written';
}

/** The outcome of the labelled-only member's remote write: 'written', or the error code it was refused with. */
async function labelledWrite(engine: BrainEngine, operation: 'put_page' | 'capture', params: Record<string, unknown>): Promise<string> {
  const out = await memberWriteOutcome(engine, LABELLED, operation, params);
  return out === 'written' ? 'written' : String(out.code);
}

/** The page's stored state, as a write must leave it or change it. */
async function pageState(engine: BrainEngine, slug: string): Promise<{ body: string | null; versions: number }> {
  const page = await engine.getPage(slug, { sourceId: SRC });
  return { body: page?.compiled_truth ?? null, versions: (await engine.getVersions(slug, { sourceId: SRC })).length };
}

describe('engine parity: a labelled-only member\'s remote writes', () => {
  // The create and the capture of a page that names nobody the writer is end on the same refusal on every arm, whole body included
  // (code, message and the fix the operator is shown), and nothing is written.
  parityTest('a labelled-only member\'s put_page rewrite of an open page, and its put_page or capture of a new page, that do not name it are refused with the same error and write nothing', { methods: ['readWriteVisibilityProbe', 'readLinkTargetPages'], timeout: 120_000 }, async (engine, backend) => {
    await seed(engine, backend);
    await engine.putPage('notes/open', { type: 'note', title: 'Open', compiled_truth: 'First.', timeline: '', frontmatter: {} }, { sourceId: SRC });
    const state = (slug: string) => pageState(engine, slug);
    const snapshot = async () => ({ open: await state('notes/open'), fresh: await state('notes/fresh'), captured: await state('notes/captured'), pages: await engine.countSourcePages(SRC) });
    const before = await snapshot();
    const revision = (await engine.getPage('notes/open', { sourceId: SRC }))?.knowledge_revision;
    const rewrite = await memberWriteOutcome(engine, LABELLED, 'put_page', { slug: 'notes/open', content: '---\ntitle: Open\n---\nTaken over.', expected_revision: revision });
    const create = await memberWriteOutcome(engine, LABELLED, 'put_page', { slug: 'notes/fresh', content: '---\ntitle: Fresh\n---\nNew page.' });
    const capture = await memberWriteOutcome(engine, LABELLED, 'capture', { slug: 'notes/captured', content: '---\ntitle: Captured\n---\nCaptured page.' });
    const after = await snapshot();
    expect({ rewrite: (rewrite as { code?: unknown }).code, create: (create as { code?: unknown }).code, capture: (capture as { code?: unknown }).code, after })
      .toEqual({ rewrite: 'page_not_found', create: 'access_labelled_only_unnamed', capture: 'access_labelled_only_unnamed', after: before });
    expect(before).toEqual({ open: { body: 'First.', versions: 0 }, fresh: { body: null, versions: 0 }, captured: { body: null, versions: 0 }, pages: 1 });
    return stable({ rewrite, create, capture, after });
  });
});

describe('engine parity: writers a labelled-only member does not change', () => {
  // The owner and an ordinary member are not labelled-only. While another member carries the grant (active, disabled or removed;
  // the grant row stays either way), their remote rewrite of an open page must be judged as it is with no such member: written.
  // Each case returns the whole outcome of both writers, so PGLite, Postgres and Rust must answer the same bytes.
  for (const state of ['active', 'disabled', 'removed'] as const) {
    parityTest(`the owner and an ordinary member still rewrite an open page while a labelled-only member is ${state}`, { methods: ['readWriteVisibilityProbe'] }, async (engine, backend) => {
      await seed(engine, backend);
      if (state === 'disabled') await disableMember(engine, LABELLED);
      if (state === 'removed') await removeMember(engine, LABELLED);
      await engine.putPage('notes/open', { type: 'note', title: 'Open', compiled_truth: 'First.', timeline: '', frontmatter: {} }, { sourceId: SRC });
      const rewrite = async (member: string, text: string) => {
        const revision = (await engine.getPage('notes/open', { sourceId: SRC }))?.knowledge_revision;
        const outcome = await memberWriteOutcome(engine, member, 'put_page', { slug: 'notes/open', content: `---\ntitle: Open\n---\n${text}`, expected_revision: revision });
        return { outcome: outcome === 'written' ? 'written' : outcome, page: await pageState(engine, 'notes/open') };
      };
      const owner = await rewrite(OWNER, 'Owner text.');
      const plain = await rewrite(PLAIN, 'Member text.');
      expect({ owner: owner.outcome, plain: plain.outcome }).toEqual({ owner: 'written', plain: 'written' });
      expect({ owner: owner.page.body, plain: plain.page.body }).toEqual({ owner: 'Owner text.', plain: 'Member text.' });
      return { state, owner, plain };
    });
  }
});

describe('engine parity: a labelled-only member\'s rewrite of a page, by what the page names', () => {
  const TEAM_RULE = { id: 'team', prefix: 'notes/', readable_by: [`member:${LABELLED}`] };
  const OTHER_RULE = { id: 'others', prefix: 'notes/', readable_by: [`member:${OWNER}`] };
  const named = (...readers: string[]) => ({ readable_by: readers });
  /** One page shape: the page's frontmatter, the folder rules stamped on it, whether the stamp is then retired (the rule removed, no restamp yet), and the answer. */
  const shapes: Array<{ name: string; frontmatter: Record<string, unknown>; rules?: typeof TEAM_RULE[]; retire?: boolean; pending?: boolean; group?: boolean; answer: 'written' | 'page_not_found' }> = [
    { name: 'an open page that names nobody', frontmatter: {}, answer: 'page_not_found' },
    { name: 'a page that names the member', frontmatter: named(`member:${LABELLED}`), answer: 'written' },
    { name: 'a page that names a group the member is in', frontmatter: named('group:team'), group: true, answer: 'written' },
    { name: 'a page that names only another member', frontmatter: named(`member:${OWNER}`), answer: 'page_not_found' },
    { name: 'a page whose readable_by is malformed', frontmatter: { readable_by: 5 }, answer: 'page_not_found' },
    { name: 'a page under a folder rule that lists the member', frontmatter: {}, rules: [TEAM_RULE], answer: 'written' },
    { name: 'a page under a folder rule that lists only another member', frontmatter: {}, rules: [OTHER_RULE], answer: 'page_not_found' },
    { name: 'a page that names the member, under a folder rule that lists only another member', frontmatter: named(`member:${LABELLED}`), rules: [OTHER_RULE], answer: 'page_not_found' },
    { name: 'a page that names only another member, under a folder rule that lists the member', frontmatter: named(`member:${OWNER}`), rules: [TEAM_RULE], answer: 'page_not_found' },
    { name: 'a page that names the member, under a prefix whose folder rule is still pending', frontmatter: named(`member:${LABELLED}`), pending: true, answer: 'page_not_found' },
    { name: 'a page stamped with a folder rule that was removed before its restamp', frontmatter: {}, rules: [TEAM_RULE], retire: true, answer: 'page_not_found' },
  ];
  for (const shape of shapes) {
    parityTest(`the rewrite of ${shape.name} answers ${shape.answer} on every arm`, { methods: ['readWriteVisibilityProbe', 'readLinkTargetPages'] }, async (engine, backend) => {
      await seed(engine, backend);
      if (shape.group) await addGroup(engine, 'team', [LABELLED]);
      if (shape.pending) await restrictFolder(engine, backend, SRC, 'notes/', 'pending');
      if (shape.rules) await proposeRevision(engine, SRC, shape.rules, { origin: 'cli', store: 'database' });
      await engine.putPage('notes/open', { type: 'note', title: 'Open', compiled_truth: 'First.', timeline: '', frontmatter: shape.frontmatter }, { sourceId: SRC });
      if (shape.retire) {
        await engine.transaction(async tx => {
          await tx.lockAccessPolicy(SRC);
          await tx.applyAccessRuleChanges(SRC, { remove: [TEAM_RULE.id], insert: [], pending: [], revision: 2, actor: 'parity' });
        });
      }
      const before = await pageState(engine, 'notes/open');
      const revision = (await engine.getPage('notes/open', { sourceId: SRC }))?.knowledge_revision;
      // The rewrite keeps the page's readers when they name the member; a list that leaves the writer out is refused earlier (readable_by_invalid), so it is not resent.
      const keep = shape.frontmatter.readable_by !== undefined && JSON.stringify(shape.frontmatter.readable_by).includes(shape.group ? 'group:team' : LABELLED);
      const readers = keep ? `readable_by: ${JSON.stringify(shape.frontmatter.readable_by)}\n` : '';
      const outcome = await memberWriteOutcome(engine, LABELLED, 'put_page', { slug: 'notes/open', content: `---\ntitle: Open\n${readers}---\nTaken over.`, expected_revision: revision });
      const after = await pageState(engine, 'notes/open');
      expect({ answer: outcome === 'written' ? 'written' : (outcome as { code?: unknown }).code }).toEqual({ answer: shape.answer });
      expect(after).toEqual(shape.answer === 'written' ? { body: 'Taken over.', versions: 1 } : before);
      return { outcome, before, after };
    });
  }
});

describe('engine parity: an ordinary member\'s rewrite of a page under a folder rule, while a labelled-only member exists', () => {
  // The writer's read policy for a writer that satisfies a folder rule is the same text for a member that is not labelled-only,
  // so the Rust store judges it the same way: written when the rule lists the writer, page_not_found when it lists another member.
  for (const listed of [true, false]) {
    parityTest(`the rewrite of a page under a folder rule that ${listed ? 'lists' : 'does not list'} the member answers ${listed ? 'written' : 'page_not_found'} on every arm`, { methods: ['readWriteVisibilityProbe', 'readLinkTargetPages'] }, async (engine, backend) => {
      await seed(engine, backend);
      await proposeRevision(engine, SRC, [{ id: 'plain', prefix: 'notes/', readable_by: [`member:${listed ? PLAIN : OWNER}`] }], { origin: 'cli', store: 'database' });
      await engine.putPage('notes/open', { type: 'note', title: 'Open', compiled_truth: 'First.', timeline: '', frontmatter: {} }, { sourceId: SRC });
      const before = await pageState(engine, 'notes/open');
      const revision = (await engine.getPage('notes/open', { sourceId: SRC }))?.knowledge_revision;
      const outcome = await memberWriteOutcome(engine, PLAIN, 'put_page', { slug: 'notes/open', content: '---\ntitle: Open\n---\nMember text.', expected_revision: revision });
      const after = await pageState(engine, 'notes/open');
      expect({ answer: outcome === 'written' ? 'written' : (outcome as { code?: unknown }).code }).toEqual({ answer: listed ? 'written' : 'page_not_found' });
      expect(after).toEqual(listed ? { body: 'Member text.', versions: 1 } : before);
      return { outcome, before, after };
    });
  }
});

describe('engine parity: the links a labelled-only member\'s rewrite creates', () => {
  // A successful rewrite of a page that names the member, whose body mentions other pages: the remote links effect (persistence/effect-links.ts,
  // writableTargets) reads each target under the writer's read policy (readLinkTargetPages), so an edge goes only to a page the labelled-only writer
  // can read: one that names the member (or a group it is in), or sits under a folder rule that lists it. An open page, a page that names only another
  // member, and a page under a rule that lists only another member get no edge, and read like an absent page. Every arm must leave the same edges.
  const TEAM_RULE = { id: 'team-rule', prefix: 'team/', readable_by: [`member:${LABELLED}`] };
  const OTHER_RULE = { id: 'other-rule', prefix: 'others/', readable_by: [`member:${OWNER}`] };
  const MENTIONED = ['notes/named', 'notes/group-named', 'team/ruled', 'notes/open', 'notes/other-named', 'others/ruled', 'notes/ghost'];
  parityTest('the rewrite of a page that names the member links only the pages the member can read, and not an open page or a page naming another member', { methods: ['readWriteVisibilityProbe', 'readLinkTargetPages', 'getLinks'], timeout: 240_000 }, async (engine, backend) => {
    await seed(engine, backend);
    await addGroup(engine, 'team', [LABELLED]);
    await proposeRevision(engine, SRC, [TEAM_RULE, OTHER_RULE], { origin: 'cli', store: 'database' });
    const page = (slug: string, frontmatter: Record<string, unknown>) => engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `${slug} fixture.`, timeline: '', frontmatter }, { sourceId: SRC });
    await page('notes/mine', { readable_by: [`member:${LABELLED}`] });
    await page('notes/named', { readable_by: [`member:${LABELLED}`] });
    await page('notes/group-named', { readable_by: ['group:team'] });
    await page('team/ruled', {});
    await page('notes/open', {});
    await page('notes/other-named', { readable_by: [`member:${OWNER}`] });
    await page('others/ruled', {});
    const revision = (await engine.getPage('notes/mine', { sourceId: SRC }))?.knowledge_revision;
    const body = `Mentions ${MENTIONED.map(slug => `[[${slug}]]`).join(', ')}.`;
    const credential: { id?: string } = {};
    const dispatched = await memberDispatch(engine, LABELLED, 'put_page', { slug: 'notes/mine', content: `---\ntitle: Mine\nreadable_by: ["member:${LABELLED}"]\n---\n${body}`, expected_revision: revision }, credential);
    expect('thrown' in dispatched || dispatched.isError === true).toBe(false);
    // The receipt names the caller's request_id; the effects are filed under the journal row of that request (token, request_id).
    const clientRequestId = (JSON.parse((dispatched as { content: Array<{ text: string }> }).content.map(c => c.text).join('')) as { request_id?: string }).request_id;
    const request = await engine.readWriteRequest('legacy_token', credential.id!, clientRequestId!);
    expect(request?.id).toBeTruthy();
    const requestId = request!.id;
    // The links effect runs after the write, not inside it: run passes until that request's links effect has finished.
    const links = async () => (await engine.readRequestEffects(requestId!)).find(e => e.kind === 'links')?.outcome;
    const settled = async () => (await links())?.links;
    for (let pass = 0; pass < 100 && !await settled(); pass++) {
      await runPersistenceEffects(engine, { engine: engine.kind }, { hostId: localHostId(), limit: 10 });
      await Bun.sleep(50);
    }
    expect(await settled()).toBe('committed');
    // What the effect reports: an unreadable page is skipped as `missing`, the reason an absent page gets.
    const effect = await links() as { added: number; skipped_targets: Array<{ slug: string; reason: string }> };
    const skipped = Object.fromEntries(effect.skipped_targets.map(t => [t.slug, t.reason]).sort());
    expect({ added: effect.added, skipped }).toEqual({ added: 3, skipped: { 'notes/ghost': 'missing', 'notes/open': 'missing', 'notes/other-named': 'missing', 'others/ruled': 'missing' } });
    const edges = (await engine.getLinks('notes/mine', { sourceId: SRC })).map(l => `${l.link_type}:${l.to_slug}`).sort();
    expect(edges).toEqual(['notes/group-named', 'notes/named', 'team/ruled'].map(slug => `mentions:${slug}`));
    return { edges, effect: { added: effect.added, skipped }, page: await pageState(engine, 'notes/mine') };
  });
});

describe('engine parity: a labelled-only member\'s create of a page that names it', () => {
  // A labelled-only writer is held to the readers check for every slug, and a slug with no live row is judged on its soft-deleted
  // row, if any (readPageHiddenFromWriter). A page that names the member, or a group it is in, is written on every arm, and the
  // stored page is the same: its body, frontmatter, version count and knowledge_revision.
  parityTest('put_page or capture of a new page that names the member, or a group it is in, is written and stores the same page on every arm', { methods: ['readWriteVisibilityProbe', 'readLinkTargetPages'], timeout: 120_000 }, async (engine, backend) => {
    await seed(engine, backend);
    await addGroup(engine, 'team', [LABELLED]);
    const named = (title: string, reader: string) => `---\ntitle: ${title}\nreadable_by: ["${reader}"]\n---\nNew page.`;
    const jobs = [['put_page', 'notes/by-member', `member:${LABELLED}`], ['capture', 'notes/captured-by-member', `member:${LABELLED}`],
      ['put_page', 'notes/by-group', 'group:team'], ['capture', 'notes/captured-by-group', 'group:team']] as const;
    const outcomes: Record<string, unknown> = {};
    for (const [operation, slug, reader] of jobs) {
      const out = await memberWriteOutcome(engine, LABELLED, operation, { slug, content: named(slug, reader) });
      const page = await engine.getPage(slug, { sourceId: SRC });
      outcomes[slug] = { out, body: page?.compiled_truth ?? null, frontmatter: page?.frontmatter ?? null, revision: page?.knowledge_revision ?? null, versions: (await engine.getVersions(slug, { sourceId: SRC })).length };
    }
    expect(Object.values(outcomes).map(o => (o as { out: unknown; body: unknown }).out)).toEqual(['written', 'written', 'written', 'written']);
    expect(Object.values(outcomes).map(o => (o as { body: unknown }).body)).toEqual(['New page.', 'New page.', 'New page.', 'New page.']);
    return stable(outcomes);
  });
});

describe('engine parity: a labelled-only member\'s create of a page that names nobody, by the folder or page rules over it', () => {
  const rule = (id: string, prefix: string, ...readers: string[]) => ({ id, prefix, readable_by: readers });
  const LISTED = `member:${LABELLED}`;
  const OTHER = `member:${OWNER}`;
  // A slug with no live row is created only when a rule over it lists the member (the rule's readers and the member's satisfied rule
  // ids overlap), whatever the page names. Each shape is a put_page and a capture of one slug, answered the same on every arm.
  const shapes: Array<{ name: string; slug: string; rules: ReturnType<typeof rule>[]; answer: 'written' | 'access_labelled_only_unnamed' }> = [
    { name: 'a folder rule that lists the member', slug: 'ruled/page', rules: [rule('team', 'ruled/', LISTED)], answer: 'written' },
    { name: 'a folder rule that lists only another member', slug: 'ruled/page', rules: [rule('others', 'ruled/', OTHER)], answer: 'access_labelled_only_unnamed' },
    { name: 'two folder rules, one that lists the member and one that lists another', slug: 'ruled/page', rules: [rule('team', 'ruled/', LISTED), rule('others', 'ruled/', OTHER)], answer: 'written' },
    { name: 'a rule over another folder that lists the member', slug: 'ruled/page', rules: [rule('team', 'elsewhere/', LISTED)], answer: 'access_labelled_only_unnamed' },
    { name: 'a page rule over the exact slug that lists the member', slug: 'ruled/page', rules: [rule('exact', 'ruled/page', LISTED), rule('exact-captured', 'ruled/page-captured', LISTED)], answer: 'written' },
  ];
  for (const shape of shapes) {
    parityTest(`the create of a page that names nobody, under ${shape.name}, answers ${shape.answer} on every arm`, { methods: ['readWriteVisibilityProbe', 'readLinkTargetPages'], timeout: 120_000 }, async (engine, backend) => {
      await seed(engine, backend);
      await proposeRevision(engine, SRC, shape.rules, { origin: 'cli', store: 'database' });
      const content = '---\ntitle: Ruled\n---\nNew page.';
      const put = await memberWriteOutcome(engine, LABELLED, 'put_page', { slug: shape.slug, content });
      const captureSlug = `${shape.slug}-captured`;
      const capture = await memberWriteOutcome(engine, LABELLED, 'capture', { slug: captureSlug, content });
      const code = (out: WriteOutcome) => out === 'written' ? 'written' : String((out as { code?: unknown }).code);
      expect({ put: code(put), capture: code(capture) }).toEqual({ put: shape.answer, capture: shape.answer });
      return stable({ put, capture, stored: { put: (await pageState(engine, shape.slug)).body, capture: (await pageState(engine, captureSlug)).body } });
    });
  }
});

describe('engine parity: a labelled-only member\'s create under a prefix whose folder rule is still pending', () => {
  // A slug with no row is not hidden by anything, so the create is judged by what the page names alone; a page under a pending prefix
  // that names the member is written, and one that names nobody is refused, the same on every arm.
  for (const [name, readers, answer] of [['names the member', `readable_by: ["member:${LABELLED}"]\n`, 'written'], ['names nobody', '', 'access_labelled_only_unnamed']] as const) {
    parityTest(`the create of a page that ${name}, under a pending prefix, answers ${answer} on every arm`, { methods: ['readWriteVisibilityProbe', 'readLinkTargetPages'], timeout: 120_000 }, async (engine, backend) => {
      await seed(engine, backend);
      await restrictFolder(engine, backend, SRC, 'notes/', 'pending');
      const out = await memberWriteOutcome(engine, LABELLED, 'put_page', { slug: 'notes/fresh', content: `---\ntitle: Fresh\n${readers}---\nNew page.` });
      const result = stable({ out, body: (await pageState(engine, 'notes/fresh')).body });
      expect(out === 'written' ? 'written' : (out as { code?: unknown }).code).toBe(answer);
      return result;
    });
  }
});

describe('engine parity: a labelled-only member\'s create over a soft-deleted page', () => {
  // The write over a slug whose only row is soft-deleted is judged on that row (readPageHiddenFromWriter): a row that names the member
  // is open to it (the write goes on to ask for the deleted row's revision), a row that names nobody is not, and the refusal reads as
  // an unseen page. A refused write republishes nothing and leaves the deleted row as it was.
  // A row under a prefix whose folder rule is still pending is hidden by the member-access part before the labelled-only part is judged,
  // so it stays hidden even when it names the member (the writer's folder coverage reaches the store as part of the policy).
  for (const shape of [{ name: 'names the member', frontmatter: { readable_by: [`member:${LABELLED}`] }, answer: 'revision_required', pending: false },
    { name: 'names nobody', frontmatter: {}, answer: 'page_not_found', pending: false },
    { name: 'names the member, under a prefix whose folder rule is still pending', frontmatter: { readable_by: [`member:${LABELLED}`] }, answer: 'page_not_found', pending: true }] as const) {
    parityTest(`the put_page over a soft-deleted row that ${shape.name} answers ${shape.answer} on every arm`, { methods: ['readWriteVisibilityProbe', 'readLinkTargetPages'], timeout: 120_000 }, async (engine, backend) => {
      await seed(engine, backend);
      if (shape.pending) await restrictFolder(engine, backend, SRC, 'notes/', 'pending');
      await engine.putPage('notes/gone', { type: 'note', title: 'Gone', compiled_truth: 'First.', timeline: '', frontmatter: shape.frontmatter }, { sourceId: SRC });
      await engine.softDeletePage('notes/gone', { sourceId: SRC });
      const snapshot = async () => { const row = await engine.getPage('notes/gone', { sourceId: SRC, includeDeleted: true }); return { live: await engine.getPage('notes/gone', { sourceId: SRC }), row: row && [row.deleted_at !== null, row.compiled_truth, row.frontmatter], versions: (await engine.getVersions('notes/gone', { sourceId: SRC })).length }; };
      const before = await snapshot();
      const out = await memberWriteOutcome(engine, LABELLED, 'put_page', { slug: 'notes/gone', content: `---\ntitle: Gone\nreadable_by: ["member:${LABELLED}"]\n---\nSecond.` });
      const after = await snapshot();
      expect({ answer: (out as { code?: unknown }).code, after }).toEqual({ answer: shape.answer, after: before });
      return stable({ out, before, after });
    });
  }
});
