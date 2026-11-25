/**
 * BrainEngine parity — what a plain member (no labelled-only grant) reads through the caller record a stdio server bound
 * to it builds (access/caller.ts remoteCallerAccess, which asks access/labelled-only.ts labelledOnlyFor).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every arm a plain member reads the open pages, the pages whose readable_by names it and its folder
 *    rule's pages, and none of another member's; labelledOnlyFor is true only for a member with the grant, never the owner.
 *  - Regression: labelledOnlyFor read access_members with raw SQL and counted the refusal as labelled-only, so on a Rust
 *    brain every plain member's read was refused.
 *  - Seam: none. addMember, proposeRevision, putPage, the real caller record. A refusal is returned as a value, since
 *    the harness counts a thrown typed refusal as a pass and refusing a plain member is the bug.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { createSource, parityArms, resetArm, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { addMember } from '../../src/core/access/members.ts';
import { setMemberLabelledOnly, labelledOnlyFor } from '../../src/core/access/labelled-only.ts';
import { setOwner } from '../../src/core/access/owner.ts';
import { proposeRevision } from '../../src/core/access/policy.ts';
import { remoteCallerAccess } from '../../src/core/access/caller.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';
import { bindCredential } from '../../src/core/access/members.ts';
import { mintLegacyToken } from '../../src/core/token-mint.ts';
import { GBrainOAuthProvider } from '../../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../../src/core/sql-query.ts';
import type { AuthInfo } from '../../src/core/ops/contract.ts';

const { parityTest, arms } = parityArms(testBackends());
const SRC = 'work';
const page = (title: string, fm: Record<string, unknown> = {}) =>
  ({ type: 'note' as const, title, compiled_truth: `harbor ${title}`, timeline: '', frontmatter: { always_load: true, ...fm } });
const SLUGS = ['notes/open', 'notes/alice-labelled', 'notes/bob-labelled', 'private/alice/diary', 'private/bob/diary'];

async function seed(engine: BrainEngine, backend: ParityBackend): Promise<void> {
  await createSource(engine, backend, SRC);
  for (const id of ['alice-example', 'bob-example', 'carol-example', 'owner-example']) await addMember(engine, id);
  for (const slug of SLUGS) {
    const reader = slug.includes('-labelled') ? { readable_by: [slug.includes('alice') ? 'alice-example' : 'bob-example'] } : {};
    await engine.putPage(slug, page(slug, reader), { sourceId: SRC });
  }
  await proposeRevision(engine, SRC, [{ id: 'alice-diary', prefix: 'private/alice/', readable_by: ['member:alice-example'] },
    { id: 'bob-diary', prefix: 'private/bob/', readable_by: ['member:bob-example'] }], { origin: 'cli', store: 'database' });
}

/**
 * What `member` reads: the core page list and each page by slug, through a stdio server bound to it, or (`token`)
 * through a legacy token bound to it that the serve --http bearer check verified.
 */
async function readAs(engine: BrainEngine, member: string, door: 'stdio' | 'token' = 'stdio'): Promise<unknown> {
  await engine.setConfig('mcp.stdio_member', door === 'stdio' ? member : '');
  try {
    let auth: AuthInfo | undefined;
    if (door === 'token') {
      const minted = await mintLegacyToken(engine, { name: `key-${member}`, scopes: ['read'], takesHolders: ['world'], sourceGrant: [SRC] });
      await bindCredential(engine, { kind: 'token', id: minted.id }, { member });
      auth = await new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), engine }).verifyAccessToken(minted.token) as unknown as AuthInfo;
    }
    const access = await remoteCallerAccess(engine, auth, [], door === 'stdio' ? 'stdio' : 'http');
    return await withCallerAccess(access, async () => ({
      core: (await engine.listCorePageRows({ excludePrivate: true, forCaller: true, limit: 50 })).map(r => r.slug).sort(),
      pages: (await Promise.all(SLUGS.map(async s => (await engine.getPage(s, { sourceId: SRC, excludePrivate: true })) ? s : null))).filter(Boolean),
    }));
  } catch (error) {
    return { refused: (error as { code?: unknown }).code ?? String(error) };
  }
}

describe('engine parity: a plain member reads what it may', () => {
  parityTest('a plain member reads open pages, pages that name it and its folder, and none of another member\'s; labelledOnlyFor names only the grant', {
    methods: ['putPage', 'listCorePageRows', 'getPage', 'readAccessMembers', 'getConfig', 'setAccessMemberLabelledOnly', 'readActiveAccessTokenByHash'],
  }, async (engine, backend) => {
    await seed(engine, backend);
    const out: Record<string, unknown> = { alice: await readAs(engine, 'alice-example'), bob: await readAs(engine, 'bob-example'),
      bobByToken: await readAs(engine, 'bob-example', 'token') };
    expect(out.bobByToken).toEqual({ core: ['notes/bob-labelled', 'notes/open', 'private/bob/diary'], pages: ['notes/open', 'notes/bob-labelled', 'private/bob/diary'] });
    expect(out.alice).toEqual({ core: ['notes/alice-labelled', 'notes/open', 'private/alice/diary'], pages: ['notes/open', 'notes/alice-labelled', 'private/alice/diary'] });
    await setMemberLabelledOnly(engine, 'carol-example', true, { remote: false });
    await setOwner(engine, 'owner-example');
    await engine.setAccessMemberLabelledOnly('owner-example', true); // setMemberLabelledOnly refuses the owner
    const verdict = (id: string) => labelledOnlyFor(engine, [['group:team-a'], [`member:${id}`]]);
    out.verdict = { alice: await verdict('alice-example'), carol: await verdict('carol-example'), owner: await verdict('owner-example') };
    expect(out.verdict).toEqual({ alice: false, carol: true, owner: false });
    return out;
  });

  // Row 32e-c-1 is closed: the remote-access change serves an entity-filtered listFactsSince for a plain member on Rust, so it
  // answers on every arm and the answers match.
  test('listFactsSince with an entity filter answers a plain member on every engine, with the same facts', async () => {
    const answers: Record<string, string[]> = {};
    for (const arm of arms()) {
      await resetArm(arm);
      await seed(arm.engine, arm.backend);
      await arm.engine.setConfig('mcp.stdio_member', 'alice-example');
      const access = await remoteCallerAccess(arm.engine, undefined, [], 'stdio');
      const rows = await withCallerAccess(access, () => arm.engine.listFactsSince(SRC, new Date(0), { entitySlug: 'people/a-example', excludePrivate: true }));
      answers[arm.backend] = rows.map(r => String((r as { fact?: unknown }).fact)).sort();
    }
    const [first, ...rest] = Object.values(answers);
    expect(first).toBeDefined();
    for (const other of rest) expect(other).toEqual(first!);
  }, 120_000);
});
