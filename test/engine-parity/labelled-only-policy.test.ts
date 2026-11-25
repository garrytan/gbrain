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
 *    access_members, so the write check treated the writer as unlabelled and returned early for a page open to everyone.
 *  - Why existing coverage misses it: the labelled-only write cases (test/access-labelled-only-*.test.ts) run on PGLite and
 *    Postgres only; the parity cases of the grant set and read it, and the plain member's write case uses an unlabelled member.
 *  - Seam: none. The grant through setMemberLabelledOnly, the token through mintLegacyToken and bindCredential, the real bearer
 *    check and dispatchToolCall. A refusal is returned as a value: the harness counts a thrown typed refusal as a pass.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { createSource, parityArms, resetArm, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { addGroup, addMember, bindCredential, disableMember, removeMember } from '../../src/core/access/members.ts';
import { proposeRevision } from '../../src/core/access/policy.ts';
import { setMemberLabelledOnly } from '../../src/core/access/labelled-only.ts';
import { setOwner } from '../../src/core/access/owner.ts';
import { mintLegacyToken } from '../../src/core/token-mint.ts';
import { GBrainOAuthProvider } from '../../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../../src/core/sql-query.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import type { AuthInfo } from '../../src/core/ops/contract.ts';

const { arms, parityTest } = parityArms(testBackends());
const SRC = 'work';
const OWNER = 'alice-example';
const LABELLED = 'carol-example';
const PLAIN = 'bob-example';

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

/** `member`'s remote write through the MCP dispatch, on a token bound to it; a refusal is returned as a value. */
async function memberWriteOutcome(engine: BrainEngine, member: string, operation: 'put_page' | 'capture', params: Record<string, unknown>): Promise<WriteOutcome> {
  const minted = await mintLegacyToken(engine, { name: `k-${member}-${String(params.slug)}`, scopes: ['read', 'write'], takesHolders: ['world'], sourceGrant: [SRC] });
  await bindCredential(engine, { kind: 'token', id: minted.id }, { member });
  const auth = await new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), engine }).verifyAccessToken(minted.token) as unknown as AuthInfo;
  return dispatchToolCall(engine, operation, params, { remote: true, transport: 'http', auth, sourceId: SRC, takesHoldersAllowList: ['world'] })
    .then(out => out.isError ? JSON.parse(out.content.map(c => c.text).join('')) as Record<string, unknown> : 'written',
      (e: { code?: string }) => ({ code: String(e.code), thrown: true }));
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
  // Not a parityTest: on Rust a labelled-only member's create or capture still reaches a raw read the engine refuses (row 32e-b-3), so
  // it ends on engine_capability_missing there, and the harness fails a case that caught a refusal. What must match on every arm is
  // that the write is refused and nothing is stored, and the rewrite of an open page is refused with the same code (the cases below
  // compare the whole answer).
  test('a labelled-only member\'s put_page rewrite of an open page, and its put_page or capture of a new page, that do not name it are refused and write nothing on every arm', async () => {
    for (const arm of arms()) {
      await resetArm(arm);
      const { engine } = arm;
      await seed(engine, arm.backend);
      await engine.putPage('notes/open', { type: 'note', title: 'Open', compiled_truth: 'First.', timeline: '', frontmatter: {} }, { sourceId: SRC });
      const state = (slug: string) => pageState(engine, slug);
      const snapshot = async () => ({ open: await state('notes/open'), fresh: await state('notes/fresh'), captured: await state('notes/captured'), pages: await engine.countSourcePages(SRC) });
      const before = await snapshot();
      const revision = (await engine.getPage('notes/open', { sourceId: SRC }))?.knowledge_revision;
      const rewrite = await labelledWrite(engine, 'put_page', { slug: 'notes/open', content: '---\ntitle: Open\n---\nTaken over.', expected_revision: revision });
      const create = await labelledWrite(engine, 'put_page', { slug: 'notes/fresh', content: '---\ntitle: Fresh\n---\nNew page.' });
      const capture = await labelledWrite(engine, 'capture', { slug: 'notes/captured', content: '---\ntitle: Captured\n---\nCaptured page.' });
      expect({ backend: arm.backend, rewrite, createWritten: create === 'written', captureWritten: capture === 'written', after: await snapshot() })
        .toEqual({ backend: arm.backend, rewrite: 'page_not_found', createWritten: false, captureWritten: false, after: before });
      expect(before).toEqual({ open: { body: 'First.', versions: 0 }, fresh: { body: null, versions: 0 }, captured: { body: null, versions: 0 }, pages: 1 });
    }
    expect(arms().length).toBeGreaterThan(0);
  }, 120_000);
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
  const shapes: Array<{ name: string; frontmatter: Record<string, unknown>; rules?: typeof TEAM_RULE[]; retire?: boolean; group?: boolean; answer: 'written' | 'page_not_found' }> = [
    { name: 'an open page that names nobody', frontmatter: {}, answer: 'page_not_found' },
    { name: 'a page that names the member', frontmatter: named(`member:${LABELLED}`), answer: 'written' },
    { name: 'a page that names a group the member is in', frontmatter: named('group:team'), group: true, answer: 'written' },
    { name: 'a page that names only another member', frontmatter: named(`member:${OWNER}`), answer: 'page_not_found' },
    { name: 'a page whose readable_by is malformed', frontmatter: { readable_by: 5 }, answer: 'page_not_found' },
    { name: 'a page under a folder rule that lists the member', frontmatter: {}, rules: [TEAM_RULE], answer: 'written' },
    { name: 'a page under a folder rule that lists only another member', frontmatter: {}, rules: [OTHER_RULE], answer: 'page_not_found' },
    { name: 'a page that names the member, under a folder rule that lists only another member', frontmatter: named(`member:${LABELLED}`), rules: [OTHER_RULE], answer: 'page_not_found' },
    { name: 'a page that names only another member, under a folder rule that lists the member', frontmatter: named(`member:${OWNER}`), rules: [TEAM_RULE], answer: 'page_not_found' },
    { name: 'a page stamped with a folder rule that was removed before its restamp', frontmatter: {}, rules: [TEAM_RULE], retire: true, answer: 'page_not_found' },
  ];
  for (const shape of shapes) {
    parityTest(`the rewrite of ${shape.name} answers ${shape.answer} on every arm`, { methods: ['readWriteVisibilityProbe', 'readLinkTargetPages'] }, async (engine, backend) => {
      await seed(engine, backend);
      if (shape.group) await addGroup(engine, 'team', [LABELLED]);
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
