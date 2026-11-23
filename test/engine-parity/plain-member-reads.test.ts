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

/** What a stdio server bound to `member` reads: the core page list and each page by slug. */
async function readAs(engine: BrainEngine, member: string): Promise<unknown> {
  await engine.setConfig('mcp.stdio_member', member);
  try {
    const access = await remoteCallerAccess(engine, undefined, [], 'stdio');
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
    methods: ['putPage', 'listCorePageRows', 'getPage', 'readAccessMembers', 'getConfig', 'setAccessMemberLabelledOnly'],
  }, async (engine, backend) => {
    await seed(engine, backend);
    const out: Record<string, unknown> = { alice: await readAs(engine, 'alice-example'), bob: await readAs(engine, 'bob-example') };
    expect(out.alice).toEqual({ core: ['notes/alice-labelled', 'notes/open', 'private/alice/diary'], pages: ['notes/open', 'notes/alice-labelled', 'private/alice/diary'] });
    await setMemberLabelledOnly(engine, 'carol-example', true, { remote: false });
    await setOwner(engine, 'owner-example');
    await engine.setAccessMemberLabelledOnly('owner-example', true); // setMemberLabelledOnly refuses the owner
    const verdict = (id: string) => labelledOnlyFor(engine, [['group:team-a'], [`member:${id}`]]);
    out.verdict = { alice: await verdict('alice-example'), carol: await verdict('carol-example'), owner: await verdict('owner-example') };
    expect(out.verdict).toEqual({ alice: false, carol: true, owner: false });
    return out;
  });

  // Row 32e-c-1 (a named loss): an entity-filtered listFactsSince for a plain member still refuses on Rust, loudly.
  test('loss (32e-c-1): listFactsSince with an entity filter refuses a plain member on Rust and answers elsewhere', async () => {
    for (const arm of arms()) {
      await resetArm(arm);
      await seed(arm.engine, arm.backend);
      await arm.engine.setConfig('mcp.stdio_member', 'alice-example');
      const access = await remoteCallerAccess(arm.engine, undefined, [], 'stdio');
      const outcome = await withCallerAccess(access, () => arm.engine.listFactsSince(SRC, new Date(0), { entity: 'people/a-example', excludePrivate: true } as never))
        .then(() => 'answers', (e: { code?: string }) => String(e.code));
      expect({ backend: arm.backend, outcome }).toEqual({ backend: arm.backend, outcome: arm.backend === 'rust' ? 'engine_capability_missing' : 'answers' });
    }
  }, 120_000);
});
