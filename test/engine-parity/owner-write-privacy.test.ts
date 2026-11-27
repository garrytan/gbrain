/**
 * BrainEngine parity — the brain owner's own remote put_page, through the MCP dispatch a bound legacy token drives.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every arm the owner's own put_page of a new page is written, and the owner's put_page of an existing
 *    private page whose content names no visibility leaves the page private.
 *  - Regression: the owner's write reads the stored page's privacy (persistence/page-visibility.ts ownerRewriteOf) with
 *    raw SQL, which the Rust engine refuses, so the owner's own remote put_page was refused with engine_capability_missing.
 *  - Why existing coverage misses it: plain-member-writes pinned the refusal as a named loss; the owner write
 *    suite (test/owner-remote-private-writes-gst2091.test.ts) runs on PGLite and Postgres only.
 *  - Seam: none. The owner through setOwner, the token through mintLegacyToken and bindCredential, the real bearer check
 *    and dispatchToolCall. A refusal is returned as a value: the harness counts a thrown typed refusal as a pass.
 *
 * Served arm (GBRAIN_TEST_RUST_SERVED=1 with the rust-mu view): the engine is a served client of the multi-user owner, and a remote
 * caller's put_page crosses as one whole operation (rust-engine/served/remote-whole-ops.ts) that the server runs as in process, so
 * every case compares as on the other arms. The typed-read failure case injects its failure on the server's engine too.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { createSource, parityArms, resetArm, stopOnRemoteWriteRefusal, type ParityBackend, type RemoteWriteSite } from './harness.ts';
import { servedOwnerOf } from './rust-arm.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { addMember, bindCredential } from '../../src/core/access/members.ts';
import { setOwner } from '../../src/core/access/owner.ts';
import { proposeRevision } from '../../src/core/access/policy.ts';
import { mintLegacyToken } from '../../src/core/token-mint.ts';
import { GBrainOAuthProvider } from '../../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../../src/core/sql-query.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import type { AuthInfo } from '../../src/core/ops/contract.ts';
import { withEngineScope } from '../../src/core/engine-scope.ts';
import { __resetPrivateVisibilityCacheForTests, HONOR_ALIASES_KEY, readHonorAliases } from '../../src/core/search/private-visibility.ts';

const { parityTest, arms } = parityArms(testBackends());
const SRC = 'work';
const OWNER = 'alice-example';

async function seed(engine: BrainEngine, backend: ParityBackend): Promise<void> {
  await createSource(engine, backend, SRC);
  await addMember(engine, OWNER);
  await setOwner(engine, OWNER);
}

/**
 * The outcome of the owner's own put_page: 'written', or the error code it was refused with. `pinned` (default) lets a multi-user
 * served run end the case on the served client's refusal of a remote write (stopOnRemoteWriteRefusal); a case that is not pinned to it
 * passes false and reads the refusal as a value.
 */
async function ownerPut(engine: BrainEngine, slug: string, content: string, expected_revision?: string, member = OWNER, pinned: RemoteWriteSite | false = 'member'): Promise<string> {
  const minted = await mintLegacyToken(engine, { name: `k-${slug}`, scopes: ['read', 'write'], takesHolders: ['world'], sourceGrant: [SRC] });
  await bindCredential(engine, { kind: 'token', id: minted.id }, { member });
  const auth = await new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), engine }).verifyAccessToken(minted.token) as unknown as AuthInfo;
  const params = { slug, content, ...(expected_revision ? { expected_revision } : {}) };
  return dispatchToolCall(engine, 'put_page', params, { remote: true, transport: 'http', auth, sourceId: SRC, takesHoldersAllowList: ['world'] })
    .then(out => {
      if (!out.isError) return 'written';
      const text = out.content.map(c => c.text).join('');
      if (pinned) stopOnRemoteWriteRefusal(text, pinned);
      return String((JSON.parse(text) as { code?: unknown }).code);
    }, (e: { code?: string }) => String(e.code));
}

/** The pin's no-effect check: the page the case seeded is still as it was (a refused write changed nothing). */
const untouched = (slug: string, body: string) => async (engine: BrainEngine): Promise<void> => {
  expect((await engine.getPage(slug, { sourceId: SRC }))?.compiled_truth, `${slug} changed although the write was refused`).toBe(body);
};

describe('engine parity: the brain owner\'s own remote put_page', () => {
  parityTest('the owner\'s put_page of a new page is written', { methods: ['putPage', 'readPagePrivacyHidden'] }, async (engine, backend) => {
    await seed(engine, backend);
    const out = await ownerPut(engine, 'notes/by-owner', '---\ntitle: Note\n---\nHarbor notes.');
    const result = { out, hidden: await engine.readPagePrivacyHidden(SRC, 'notes/by-owner'), missing: await engine.readPagePrivacyHidden(SRC, 'notes/none') };
    expect(result).toEqual({ out: 'written', hidden: false, missing: null });
    return result;
  });

  parityTest('the owner\'s put_page rewrite of a private page, naming no visibility, leaves it private', { methods: ['putPage', 'getPage', 'readPagePrivacyHidden'] }, async (engine, backend) => {
    await seed(engine, backend);
    await engine.putPage('notes/diary', { type: 'note', title: 'Diary', compiled_truth: 'First entry.', timeline: '', frontmatter: { visibility: 'private' } }, { sourceId: SRC });
    const out = await ownerPut(engine, 'notes/diary', '---\ntitle: Diary\n---\nSecond entry.', (await engine.getPage('notes/diary', { sourceId: SRC }))?.knowledge_revision);
    const result = { out, visibility: (await engine.getPage('notes/diary', { sourceId: SRC }))?.frontmatter.visibility ?? null };
    expect(result).toEqual({ out: 'written', visibility: 'private' });
    return result;
  });

  parityTest('the owner\'s put_page over a page whose readers leave the owner out is refused alike', { methods: ['putPage', 'getPage'] }, async (engine, backend) => {
    await seed(engine, backend);
    await addMember(engine, 'bob-example');
    await engine.putPage('notes/vault', { type: 'note', title: 'Vault', compiled_truth: 'Bob only.', timeline: '', frontmatter: { visibility: 'private', readable_by: ['bob-example'] } }, { sourceId: SRC });
    const out = await ownerPut(engine, 'notes/vault', '---\ntitle: Vault\n---\nTaken.', (await engine.getPage('notes/vault', { sourceId: SRC }))?.knowledge_revision);
    expect(out).not.toBe('written');
    return out;
  });

  parityTest('the owner\'s put_page rewrite of a page naming the owner as a reader, on a brain with an owner-only source, is written', { methods: ['putPage', 'getPage'] }, async (engine, backend) => {
    await seed(engine, backend);
    await createSource(engine, backend, 'vault', { owner_only: true });
    await addMember(engine, 'bob-example');
    await engine.putPage('notes/shared', { type: 'note', title: 'Shared', compiled_truth: 'First.', timeline: '', frontmatter: { readable_by: [OWNER, 'bob-example'] } }, { sourceId: SRC });
    const out = await ownerPut(engine, 'notes/shared', `---\ntitle: Shared\nreadable_by: [${OWNER}, bob-example]\n---\nSecond.`, (await engine.getPage('notes/shared', { sourceId: SRC }))?.knowledge_revision);
    expect(out).toBe('written');
    return out;
  });

  parityTest('a page with `access: private` and no visibility is private to the privacy read only while visibility.honor_aliases is on', { methods: ['putPage', 'readPagePrivacyHidden', 'setConfig'] }, async (engine, backend) => {
    await seed(engine, backend);
    await engine.putPage('notes/aliased', { type: 'note', title: 'Aliased', compiled_truth: 'Body.', timeline: '', frontmatter: { access: 'private' } }, { sourceId: SRC });
    const hidden = async (value: string) => { __resetPrivateVisibilityCacheForTests(); await engine.setConfig(HONOR_ALIASES_KEY, value); return withEngineScope(engine, async () => { await readHonorAliases(engine); return engine.readPagePrivacyHidden(SRC, 'notes/aliased'); }); };
    const result = { on: await hidden('true'), off: await hidden('false'), onAgain: await hidden('true') };
    expect(result).toEqual({ on: true, off: false, onAgain: true });
    return result;
  });

  // Not a parityTest: on Rust a non-owner member's call also reaches a labelled-only raw read that the dispatch swallows (row 32e-b),
  // and the harness fails a case that caught a refusal. The answers must still be equal on every arm.
  const PLAIN_MEMBER = 'a plain member\'s put_page rewrite of an existing page, open or naming its readers, is written on every arm';
  test(PLAIN_MEMBER, async () => {
    for (const arm of arms()) {
      await resetArm(arm);
      const { engine } = arm;
      const untouchedBoth = async (e: BrainEngine): Promise<void> => { await untouched('notes/open', 'First.')(e); await untouched('notes/shared', 'First.')(e); };
      {
        await seed(engine, arm.backend);
        await addMember(engine, 'bob-example');
        const input = (frontmatter: Record<string, unknown>) => ({ type: 'note' as const, title: 'Note', compiled_truth: 'First.', timeline: '', frontmatter });
        await engine.putPage('notes/open', input({}), { sourceId: SRC });
        await engine.putPage('notes/shared', input({ readable_by: ['bob-example'] }), { sourceId: SRC });
        const rewrite = async (slug: string, readers = '') => ownerPut(engine, slug, `---\ntitle: Note\n${readers}---\nSecond.`, (await engine.getPage(slug, { sourceId: SRC }))?.knowledge_revision, 'bob-example', 'operation');
        expect({ backend: arm.backend, open: await rewrite('notes/open'), shared: await rewrite('notes/shared', 'readable_by: [bob-example]\n') })
          .toEqual({ backend: arm.backend, open: 'written', shared: 'written' });
      }
    }
    expect(arms().length).toBeGreaterThan(0);
  }, 120_000);

  // A typed read that fails during a remote put_page must refuse it with that failure: a swallowed one would read as "not hidden" and publish (a later guard may still refuse).
  const TYPED_READ = 'a failure of a typed visibility read refuses the write and publishes nothing';
  test(TYPED_READ, async () => {
    const cases = [['ownerOnLivePage', 'readPagePrivacyHidden', 1, OWNER, 'diary'], ['ownerRewriteOf', 'readPagePrivacyHidden', 2, OWNER, 'diary'], ['hiddenUnder', 'readLinkTargetPages', 1, 'bob-example', 'vault']] as const;
    for (const arm of arms()) for (const [site, member, from, writer, slug] of cases) {
      await resetArm(arm);
      // The pin's no-effect check: the page and its versions are as the case seeded them (set once the case has taken its snapshot).
      let unchanged = async (): Promise<void> => undefined;
      {
        // On the served arm the write runs on the brain server, so the failure is injected on its owner engine as well.
        const targets = [arm.engine, servedOwnerOf(arm.engine)].filter(Boolean) as unknown as Array<Record<string, (...args: unknown[]) => Promise<unknown>>>;
        await seed(arm.engine, arm.backend);
        await addMember(arm.engine, 'bob-example');
        const frontmatter = slug === 'diary' ? { visibility: 'private' } : { visibility: 'private', readable_by: [OWNER] };
        await arm.engine.putPage(`notes/${slug}`, { type: 'note', title: slug, compiled_truth: 'First.', timeline: '', frontmatter }, { sourceId: SRC });
        const snapshot = async () => { const page = await arm.engine.getPage(`notes/${slug}`, { sourceId: SRC }); return { page: page && [page.compiled_truth, page.frontmatter, page.knowledge_revision], versions: (await arm.engine.getVersions(`notes/${slug}`, { sourceId: SRC })).length }; };
        const before = await snapshot();
        unchanged = async () => { expect(await snapshot(), `${slug} changed although the write was refused`).toEqual(before); };
        let calls = 0, thrown = 0;
        const restore = targets.map((engine) => {
          const original = engine[member]!;
          const own = Object.getOwnPropertyDescriptor(engine, member);
          engine[member] = function (this: unknown, ...args: unknown[]) { if (++calls !== from) return original.apply(this, args); thrown++; return Promise.reject(new Error('injected read failure')); };
          return () => { if (own) Object.defineProperty(engine, member, own); else delete engine[member]; };
        });
        const out = await ownerPut(arm.engine, `notes/${slug}`, `---\ntitle: ${slug}\n${slug === 'vault' ? `readable_by: [${OWNER}, bob-example]\n` : ''}---\nSecond.`, before.page?.[2] as string, writer, 'operation').finally(() => { for (const undo of restore) undo(); });
        expect({ backend: arm.backend, site, fired: thrown > 0, failed: ['internal_error', 'storage_error'].includes(out), after: await snapshot() }).toEqual({ backend: arm.backend, site, fired: true, failed: true, after: before });
        void unchanged;
      }
    }
    expect(arms().length).toBeGreaterThan(0);
  }, 240_000);

  // The deleted-row fallback of the same check (readPageHiddenFromWriter) must fail the write too: a swallowed failure would read as "not hidden"
  // and republish a deleted page the writer may not read.
  test('a failure of the hidden-writer read refuses a write over a soft-deleted page and publishes nothing', async () => {
    for (const arm of arms()) {
      await resetArm(arm);
      const engine = arm.engine as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
      await seed(arm.engine, arm.backend);
      await addMember(arm.engine, 'bob-example');
      await arm.engine.putPage('notes/gone', { type: 'note', title: 'gone', compiled_truth: 'First.', timeline: '', frontmatter: { readable_by: [OWNER] } }, { sourceId: SRC });
      await arm.engine.softDeletePage('notes/gone', { sourceId: SRC });
      const snapshot = async () => { const row = await arm.engine.getPage('notes/gone', { sourceId: SRC, includeDeleted: true }); return { live: await arm.engine.getPage('notes/gone', { sourceId: SRC }), row: row && [row.deleted_at !== null, row.compiled_truth], pages: await arm.engine.countSourcePages(SRC, { includeDeleted: true }), versions: (await arm.engine.getVersions('notes/gone', { sourceId: SRC })).length }; };
      const before = await snapshot();
      const original = engine.readPageHiddenFromWriter!; let thrown = 0;
      engine.readPageHiddenFromWriter = function () { thrown++; return Promise.reject(new Error('injected read failure')); };
      const out = await ownerPut(arm.engine, 'notes/gone', '---\ntitle: gone\n---\nSecond.', undefined, 'bob-example').finally(() => { engine.readPageHiddenFromWriter = original; });
      expect({ backend: arm.backend, fired: thrown > 0, failed: ['internal_error', 'storage_error'].includes(out), after: await snapshot() }).toEqual({ backend: arm.backend, fired: true, failed: true, after: before });
    }
    expect(arms().length).toBeGreaterThan(0);
  }, 120_000);

  // A plain member's put_page over a slug with only a soft-deleted row. The opening probe sees that row (it names readers), so the check is
  // not decided early and readLinkTargetPages returns no live row; the row is then judged by readPageHiddenFromWriter, on every arm, and the
  // write is refused as an unseen page. Nothing is written: no live row, no version, the deleted row as it was.
  for (const shape of [{ name: 'names readers', frontmatter: { readable_by: [OWNER] } as Record<string, unknown>, rules: [] as Array<{ id: string; prefix: string; readable_by: string[] }> }, { name: 'sits under a folder rule that lists only the owner', frontmatter: {}, rules: [{ id: 'owner-only', prefix: 'notes/', readable_by: [`member:${OWNER}`] }] }]) {
    parityTest(`a plain member's put_page over a soft-deleted page that ${shape.name} is refused as an unseen page and writes nothing on every arm`, { methods: ['readLinkTargetPages'], timeout: 120_000 }, async (engine, backend) => {
      await seed(engine, backend);
      await addMember(engine, 'bob-example');
      if (shape.rules.length) await proposeRevision(engine, SRC, shape.rules, { origin: 'cli', store: 'database' });
      await engine.putPage('notes/gone', { type: 'note', title: 'Gone', compiled_truth: 'First.', timeline: '', frontmatter: shape.frontmatter }, { sourceId: SRC });
      await engine.softDeletePage('notes/gone', { sourceId: SRC });
      const snapshot = async () => { const row = await engine.getPage('notes/gone', { sourceId: SRC, includeDeleted: true }); return { live: await engine.getPage('notes/gone', { sourceId: SRC }), row: row && [row.deleted_at !== null, row.compiled_truth, row.frontmatter, row.knowledge_revision], pages: await engine.countSourcePages(SRC, { includeDeleted: true }), versions: (await engine.getVersions('notes/gone', { sourceId: SRC })).length }; };
      const before = await snapshot();
      const out = await ownerPut(engine, 'notes/gone', '---\ntitle: Gone\n---\nSecond.', undefined, 'bob-example', false);
      const result = { out, after: await snapshot() };
      expect(result).toEqual({ out: 'page_not_found', after: before });
      expect(before).toMatchObject({ live: null, pages: 1, versions: 0 });
      return JSON.parse(JSON.stringify(result).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>')) as typeof result;
    });
  }
});
