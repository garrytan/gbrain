/**
 * BrainEngine parity — a labelled-only member's remote page writes, through the MCP dispatch a bound legacy token drives.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a labelled-only member (access_members.labelled_only) reads only pages that name it, so its remote put_page
 *    or capture may not rewrite an open page that does not name it, and may not create a page that does not name it. The
 *    refusal is the same on every arm and nothing is written: the body, the version count and the page list stay as they were.
 *  - Regression: the Rust opening probe (readWriteVisibilityProbe) always answers `any_labelled: false` and never reads
 *    access_members, so the write check treats the writer as unlabelled and returns early for a page open to everyone.
 *  - Why existing coverage misses it: the labelled-only write cases (test/access-labelled-only-*.test.ts) run on PGLite and
 *    Postgres only; the parity cases of the grant set and read it, and the plain member's write case uses an unlabelled member.
 *  - Seam: none. The grant through setMemberLabelledOnly, the token through mintLegacyToken and bindCredential, the real bearer
 *    check and dispatchToolCall. A refusal is returned as a value: the harness counts a thrown typed refusal as a pass.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { createSource, parityArms, resetArm, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { addMember, bindCredential } from '../../src/core/access/members.ts';
import { setMemberLabelledOnly } from '../../src/core/access/labelled-only.ts';
import { setOwner } from '../../src/core/access/owner.ts';
import { mintLegacyToken } from '../../src/core/token-mint.ts';
import { GBrainOAuthProvider } from '../../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../../src/core/sql-query.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import type { AuthInfo } from '../../src/core/ops/contract.ts';

const { arms } = parityArms(testBackends());
const SRC = 'work';
const OWNER = 'alice-example';
const LABELLED = 'carol-example';

async function seed(engine: BrainEngine, backend: ParityBackend): Promise<void> {
  await createSource(engine, backend, SRC);
  await addMember(engine, OWNER);
  await setOwner(engine, OWNER);
  await addMember(engine, LABELLED);
  await setMemberLabelledOnly(engine, LABELLED, true, { remote: false });
}

/** The outcome of the labelled-only member's remote write: 'written', or the error code it was refused with. */
async function labelledWrite(engine: BrainEngine, operation: 'put_page' | 'capture', params: Record<string, unknown>): Promise<string> {
  const minted = await mintLegacyToken(engine, { name: `k-${String(params.slug)}`, scopes: ['read', 'write'], takesHolders: ['world'], sourceGrant: [SRC] });
  await bindCredential(engine, { kind: 'token', id: minted.id }, { member: LABELLED });
  const auth = await new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), engine }).verifyAccessToken(minted.token) as unknown as AuthInfo;
  return dispatchToolCall(engine, operation, params, { remote: true, transport: 'http', auth, sourceId: SRC, takesHoldersAllowList: ['world'] })
    .then(out => out.isError ? String((JSON.parse(out.content.map(c => c.text).join('')) as { code?: unknown }).code) : 'written',
      (e: { code?: string }) => String(e.code));
}

describe('engine parity: a labelled-only member\'s remote writes', () => {
  // Not a parityTest: on Rust a labelled-only member's call also reaches a raw read the engine refuses (row 32e-b), so a create or
  // a capture ends on engine_capability_missing there, and the harness fails a case that caught a refusal. What must match on every
  // arm is that the write is refused and nothing is stored; the rewrite of an open page is refused with page_not_found alike.
  test('a labelled-only member\'s put_page rewrite of an open page, and its put_page or capture of a new page, that do not name it are refused and write nothing on every arm', async () => {
    for (const arm of arms()) {
      await resetArm(arm);
      const { engine } = arm;
      await seed(engine, arm.backend);
      await engine.putPage('notes/open', { type: 'note', title: 'Open', compiled_truth: 'First.', timeline: '', frontmatter: {} }, { sourceId: SRC });
      const state = async (slug: string) => {
        const page = await engine.getPage(slug, { sourceId: SRC });
        return { body: page?.compiled_truth ?? null, versions: (await engine.getVersions(slug, { sourceId: SRC })).length };
      };
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
