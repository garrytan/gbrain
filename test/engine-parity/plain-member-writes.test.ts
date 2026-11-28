/**
 * BrainEngine parity — a plain member's (no labelled-only grant) writes on a brain where another member has the grant,
 * through the MCP dispatch a bound legacy token drives (put_page, capture), and the attested door's caller record
 * (access/actor.ts attestedCallerAccess).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every arm a plain member's put_page and capture are written and the attested door marks only the
 *    member with the grant as labelled-only. A labelled-only member's unlabelled put_page is refused with
 *    access_labelled_only_unnamed on every arm (row 32e-b-3 made the Rust create check answer as PGLite does).
 *  - Regression: the write check (persistence/page-visibility.ts writerLabelledOnly) read the owner with raw SQL, which
 *    the Rust engine refuses, so every remote write on a Rust brain with a labelled-only member was refused.
 *  - Why existing coverage misses it: the write parity cases run on brains with no labelled-only member, where the
 *    check never reads the owner.
 *  - Seam: none. Members through addMember, tokens through mintLegacyToken and bindCredential, the real bearer check
 *    and dispatchToolCall. A refusal is returned as a value: the harness counts a thrown typed refusal as a pass.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { createSource, parityArms, resetArm, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { addMember, bindCredential } from '../../src/core/access/members.ts';
import { setMemberLabelledOnly } from '../../src/core/access/labelled-only.ts';
import { setOwner } from '../../src/core/access/owner.ts';
import { attestedCallerAccess } from '../../src/core/access/actor.ts';
import { mintLegacyToken } from '../../src/core/token-mint.ts';
import { GBrainOAuthProvider } from '../../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../../src/core/sql-query.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import type { AuthInfo } from '../../src/core/ops/contract.ts';

const { parityTest, arms } = parityArms(testBackends());
const SRC = 'work';

async function seed(engine: BrainEngine, backend: ParityBackend): Promise<void> {
  await createSource(engine, backend, SRC);
  for (const id of ['alice-example', 'bob-example', 'carol-example']) await addMember(engine, id);
  await setMemberLabelledOnly(engine, 'carol-example', true, { remote: false });
}

/** The outcome of one tool call by `member`'s bound token: 'written', or the error code it was refused with. */
async function write(engine: BrainEngine, member: string, tool: 'put_page' | 'capture', slug: string): Promise<string> {
  const minted = await mintLegacyToken(engine, { name: `k-${member}-${tool}`, scopes: ['read', 'write'], takesHolders: ['world'], sourceGrant: [SRC] });
  await bindCredential(engine, { kind: 'token', id: minted.id }, { member });
  const auth = await new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), engine }).verifyAccessToken(minted.token) as unknown as AuthInfo;
  const params = tool === 'put_page' ? { slug, content: '---\ntitle: Note\n---\nHarbor notes.' } : { slug, content: 'Harbor notes.' };
  return dispatchToolCall(engine, tool, params, { remote: true, transport: 'http', auth, sourceId: SRC, takesHoldersAllowList: ['world'] })
    .then(out => out.isError ? String((JSON.parse(out.content.map(c => c.text).join('')) as { code?: unknown }).code) : 'written',
      (e: { code?: string }) => String(e.code));
}

describe('engine parity: a plain member writes on a brain with a labelled-only member', () => {
  parityTest('put_page and capture by a plain member are written; the attested door marks only the member with the grant', {
    methods: ['putPage', 'readAccessMembers', 'getConfig', 'readWriteVisibilityProbe'],
  }, async (engine, backend) => {
    await seed(engine, backend);
    const attested = async (member: string) =>
      (await attestedCallerAccess(engine, { system: 'qm', external_id: `ext-${member}`, member }, [`member:${member}`])).labelledOnly;
    await setOwner(engine, 'alice-example'); // an owner is named, so the write check reads it and leaves bob in
    const out = {
      bobPut: await write(engine, 'bob-example', 'put_page', 'notes/by-bob'),
      bobCapture: await write(engine, 'bob-example', 'capture', 'inbox/by-bob'),
      attested: { bob: await attested('bob-example'), carol: await attested('carol-example') },
    };
    expect(out).toEqual({ bobPut: 'written', bobCapture: 'written', attested: { bob: false, carol: true } });
    return out;
  });

  // Row 32e-d-1, closed on main by 9a4a03bd36 (the owner's own write reads the stored page's privacy through typed
  // reads): the owner's own remote put_page is written, and leaves the same page row and version, on every engine.
  test('the owner\'s own remote put_page is written on every engine, with the same stored page and version', async () => {
    const seen: { backend: string; outcome: string; stored: unknown }[] = [];
    for (const arm of arms()) {
      await resetArm(arm);
      await seed(arm.engine, arm.backend);
      await setOwner(arm.engine, 'alice-example');
      const outcome = await write(arm.engine, 'alice-example', 'put_page', 'notes/by-alice');
      const page = await arm.engine.getPage('notes/by-alice', { sourceId: SRC });
      const stored = { page: page && [page.title, page.type, page.compiled_truth, page.deleted_at], versions: (await arm.engine.getVersions('notes/by-alice', { sourceId: SRC })).length };
      seen.push({ backend: arm.backend, outcome, stored });
    }
    expect(arms().length).toBeGreaterThan(0);
    for (const s of seen) expect(s).toEqual({ backend: s.backend, outcome: 'written', stored: seen[0]!.stored });
    expect(seen[0]!.stored).toEqual({ page: ['Note', 'note', 'Harbor notes.', null], versions: 0 });
  }, 120_000);

  test('a labelled-only member\'s unlabelled put_page is refused with access_labelled_only_unnamed on every arm (row 32e-b-3)', async () => {
    for (const arm of arms()) {
      await resetArm(arm);
      await seed(arm.engine, arm.backend);
      const outcome = await write(arm.engine, 'carol-example', 'put_page', 'notes/by-carol');
      expect({ backend: arm.backend, outcome }).toEqual({ backend: arm.backend, outcome: 'access_labelled_only_unnamed' });
    }
    expect(arms().length).toBeGreaterThan(0);
  }, 120_000);
});
