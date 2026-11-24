/**
 * BrainEngine parity — the brain owner's own remote put_page, through the MCP dispatch a bound legacy token drives.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every arm the owner's own put_page of a new page is written.
 *  - Regression: the owner's write reads the stored page's privacy (persistence/page-visibility.ts ownerRewriteOf) with
 *    raw SQL, which the Rust engine refuses, so the owner's own remote put_page was refused with engine_capability_missing.
 *  - Why existing coverage misses it: plain-member-writes pinned the refusal as a named loss; the owner write
 *    suite (test/owner-remote-private-writes-gst2091.test.ts) runs on PGLite and Postgres only.
 *  - Seam: none. The owner through setOwner, the token through mintLegacyToken and bindCredential, the real bearer check
 *    and dispatchToolCall. A refusal is returned as a value: the harness counts a thrown typed refusal as a pass.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { createSource, parityArms, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { addMember, bindCredential } from '../../src/core/access/members.ts';
import { setOwner } from '../../src/core/access/owner.ts';
import { mintLegacyToken } from '../../src/core/token-mint.ts';
import { GBrainOAuthProvider } from '../../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../../src/core/sql-query.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import type { AuthInfo } from '../../src/core/ops/contract.ts';

const { parityTest } = parityArms(testBackends());
const SRC = 'work';
const OWNER = 'alice-example';

async function seed(engine: BrainEngine, backend: ParityBackend): Promise<void> {
  await createSource(engine, backend, SRC);
  await addMember(engine, OWNER);
  await setOwner(engine, OWNER);
}

/** The outcome of the owner's own put_page: 'written', or the error code it was refused with. */
async function ownerPut(engine: BrainEngine, slug: string, content: string, expected_revision?: string, member = OWNER): Promise<string> {
  const minted = await mintLegacyToken(engine, { name: `k-${slug}`, scopes: ['read', 'write'], takesHolders: ['world'], sourceGrant: [SRC] });
  await bindCredential(engine, { kind: 'token', id: minted.id }, { member });
  const auth = await new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), engine }).verifyAccessToken(minted.token) as unknown as AuthInfo;
  const params = { slug, content, ...(expected_revision ? { expected_revision } : {}) };
  return dispatchToolCall(engine, 'put_page', params, { remote: true, transport: 'http', auth, sourceId: SRC, takesHoldersAllowList: ['world'] })
    .then(out => out.isError ? String((JSON.parse(out.content.map(c => c.text).join('')) as { code?: unknown }).code) : 'written',
      (e: { code?: string }) => String(e.code));
}

describe('engine parity: the brain owner\'s own remote put_page', () => {
  parityTest('the owner\'s put_page of a new page is written', { methods: ['putPage', 'readPagePrivacyHidden'] }, async (engine, backend) => {
    await seed(engine, backend);
    const out = await ownerPut(engine, 'notes/by-owner', '---\ntitle: Note\n---\nHarbor notes.');
    const result = { out, hidden: await engine.readPagePrivacyHidden(SRC, 'notes/by-owner'), missing: await engine.readPagePrivacyHidden(SRC, 'notes/none') };
    expect(result).toEqual({ out: 'written', hidden: false, missing: null });
    return result;
  });

  parityTest('a plain member\'s put_page rewrite of an existing page, open or naming its readers, is written', { methods: ['putPage', 'getPage'] }, async (engine, backend) => {
    await seed(engine, backend);
    await addMember(engine, 'bob-example');
    const input = (frontmatter: Record<string, unknown>) => ({ type: 'note' as const, title: 'Note', compiled_truth: 'First.', timeline: '', frontmatter });
    await engine.putPage('notes/open', input({}), { sourceId: SRC });
    await engine.putPage('notes/shared', input({ readable_by: ['bob-example'] }), { sourceId: SRC });
    const rewrite = async (slug: string, readers = '') => ownerPut(engine, slug, `---\ntitle: Note\n${readers}---\nSecond.`, (await engine.getPage(slug, { sourceId: SRC }))?.knowledge_revision, 'bob-example');
    const result = { open: await rewrite('notes/open'), shared: await rewrite('notes/shared', 'readable_by: [bob-example]\n') };
    expect(result).toEqual({ open: 'written', shared: 'written' });
    return result;
  });
});
