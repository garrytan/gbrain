/**
 * BrainEngine parity: a page the caller may not see at a slug that is also an alias fails closed, on a read that
 * follows slug aliases and keeps an exact slug's identity (the remote `fetch` read: `readPageSnapshot` with
 * `excludePrivate`, `resolveAlias`, `requireLiveSource` and `preserveExactIdentity`).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: for a slug X that is an alias of a visible page Y, a remote read of X answers Y when X holds no page.
 *    When X holds a page the caller may not see (`visibility: private`, or `readable_by` naming another member), the
 *    read answers nothing: the hidden page is never shown, and its alias target never stands in for it, so an id that
 *    named the page X never opens a different page. `fetch` of that id gives the plain `page_not_found`, the same error
 *    as a slug that holds no page and no alias. A page at X the caller may see answers itself. A trusted local read (no
 *    `excludePrivate`) is unchanged: any page at X answers itself. The deep research contract
 *    (test/helpers/deep-research-contract.ts, "private exact pages cannot substitute a readable stale alias target")
 *    pins the same rule through `fetch`.
 *  - Known loss: a remote caller that already knows X was renamed to Y can tell that X now holds a page it may not
 *    see (X answers nothing where a renamed-away X would answer Y). It learns that one fact, never the page's content.
 *  - Regression: a remote read whose exact-slug check ignores the caller's visibility follows the alias from a hidden
 *    page at X to Y, so a citation of X opens a different page.
 *  - Why existing coverage misses it: no parity case reads a slug that is both an alias and a (hidden) page, and the
 *    alias cases in pages.test.ts and sync-aliases.test.ts never pass `excludePrivate`.
 *  - Seam: none for the parity cases (typed methods only; the alias is made by renaming a page, then the old slug is
 *    written again). The Rust arm's `readPageSnapshot` member does not carry these options yet and stops on that typed
 *    refusal, which a parity case counts as a pass, so plain tests read the Rust store through its own handle with
 *    the options and policy the SQL arms use and must return the same answers.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { PageInput } from '../../src/core/types.ts';
import { PageSnapshotAmbiguousError } from '../../src/core/page-state/types.ts';
import { storePagePolicy, storePageTextPolicy } from '../../src/core/rust-engine/store-members/private-provenance.ts';
import { privatePagesFilterForCaller, withCallerAccess, type CallerAccess } from '../../src/core/search/private-visibility.ts';
import { operationsByName, type OperationContext } from '../../src/core/operations.ts';
import { encodeDeepResearchId } from '../../src/core/deep-research-id.ts';
import { createSource, parityArms, resetArm, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest, arms } = parityArms(testBackends());

const page = (title: string, frontmatter: Record<string, unknown> = {}): PageInput =>
  ({ type: 'note', title, compiled_truth: `About ${title}.`, timeline: '', frontmatter });

/** `from` becomes an alias of `to`: the page is written under `from`, then renamed. */
async function aliasOf(engine: BrainEngine, from: string, to: string, frontmatter: Record<string, unknown> = {}, sourceId?: string): Promise<void> {
  const opts = sourceId ? { sourceId } : undefined;
  await engine.putPage(from, page(to, frontmatter), opts);
  expect(await engine.updateSlug(from, to, opts)).toBe(1);
}

/** `slug` is an alias of a visible page and ALSO holds a page with `frontmatter` (written after the rename). */
async function aliasWithPage(engine: BrainEngine, slug: string, target: string, frontmatter: Record<string, unknown>, targetFrontmatter: Record<string, unknown> = {}): Promise<void> {
  await aliasOf(engine, slug, target, targetFrontmatter);
  await engine.putPage(slug, page(`${slug} itself`, frontmatter));
}

/** The reads one remote caller makes: by result id (an exact source) and by legacy slug (unambiguous across sources). */
type Read = (slug: string, remote: boolean, legacy: boolean) => Promise<string | null>;

const SOURCE_READS = { sourceId: 'default', resolveAlias: true, requireLiveSource: true, preserveExactIdentity: true } as const;

/** What a read answered: the slug it landed on, as `self` (the page at the slug asked) or `target` (the aliased page), or null. */
function answer(asked: string, got: { page: { slug: string } } | null): string | null {
  if (!got) return null;
  return got.page.slug === asked ? 'self' : 'target';
}

function engineRead(engine: BrainEngine): Read {
  return async (slug, remote, legacy) => answer(slug, await engine.readPageSnapshot(slug, {
    ...SOURCE_READS, requireUnambiguous: legacy, ...(remote ? { excludePrivate: true } : {}),
  }));
}

/** Every answer the case compares: the same reads of three slugs, only the page at the slug differing. */
async function reads(read: Read, hidden: string, missing: string, visible: string) {
  return {
    hiddenRemote: await read(hidden, true, false),
    hiddenRemoteLegacy: await read(hidden, true, true),
    missingRemote: await read(missing, true, false),
    missingRemoteLegacy: await read(missing, true, true),
    visibleRemote: await read(visible, true, false),
    hiddenLocal: await read(hidden, false, false),
  };
}

function expectHiddenFailsClosed(got: Awaited<ReturnType<typeof reads>>): void {
  // No page at X: the alias answers. A hidden page at X: nothing answers, never the alias target.
  expect(got.missingRemote).toBe('target');
  expect(got.missingRemoteLegacy).toBe('target');
  expect(got.hiddenRemote).toBeNull();
  expect(got.hiddenRemoteLegacy).toBeNull();
  // A page the caller may see keeps its identity, and a trusted local read sees every page at the slug.
  expect(got.visibleRemote).toBe('self');
  expect(got.hiddenLocal).toBe('self');
}

/** One remote caller's record, with page frontmatter this caller may not read, and frontmatter it may. */
interface Caller { name: string; access: Partial<CallerAccess>; hidden: Record<string, unknown>; visible: Record<string, unknown> }

const ALICE = 'member:alice-example';
const BOB = 'member:bob-example';
const CALLERS: readonly Caller[] = [
  { name: 'a named member', access: { identity: [ALICE], hidePrivate: true },
    hidden: { readable_by: [BOB] }, visible: { readable_by: [ALICE] } },
  // A labelled-only member reads only pages that name it: an unlabelled page is hidden from it.
  { name: 'a labelled-only member', access: { identity: [ALICE], hidePrivate: true, labelledOnly: true },
    hidden: {}, visible: { readable_by: [ALICE] } },
  // Every member of an audience of two must be a reader.
  { name: 'an audience of two members', access: { identity: [], audience: [ALICE, BOB], audienceIdentities: [[ALICE], [BOB]], hidePrivate: true },
    hidden: { readable_by: [ALICE] }, visible: { readable_by: [ALICE, BOB] } },
  // The owner's own read: a page whose readers name someone else stays closed to the owner.
  { name: 'an owner read', access: { identity: ['member:owner-example'], owner: true, lineage: true, ownerReadsRestricted: false, hidePrivate: true },
    hidden: { readable_by: [BOB] }, visible: {} },
  // A grant that opens the source's private pages does not open a page whose readers name someone else.
  { name: 'a caller with a private-readable grant for the source', access: { identity: [ALICE], privateReadableSources: ['default'], hidePrivate: true },
    hidden: { readable_by: [BOB] }, visible: { visibility: 'private' } },
];

/** X hidden or missing or visible, Y visible or hidden, for one caller; each pair has its own slugs. */
async function seedCaller(engine: BrainEngine, c: Caller): Promise<void> {
  await aliasOf(engine, 'notes/x-missing', 'notes/y-seen-a', c.visible);
  await aliasWithPage(engine, 'notes/x-hidden', 'notes/y-seen-b', c.hidden, c.visible);
  await aliasWithPage(engine, 'notes/x-seen', 'notes/y-seen-c', c.visible, c.visible);
  await aliasOf(engine, 'notes/x-missing-y-hidden', 'notes/y-hidden-a', c.hidden);
  await aliasWithPage(engine, 'notes/x-hidden-y-hidden', 'notes/y-hidden-b', c.hidden, c.hidden);
}

/** The five reads of one caller, each by id and by legacy slug where the answer could differ. */
async function callerReads(read: (slug: string, legacy: boolean) => Promise<string | null>) {
  return {
    hiddenXSeenY: await read('notes/x-hidden', false),
    hiddenXSeenYLegacy: await read('notes/x-hidden', true),
    missingXSeenY: await read('notes/x-missing', false),
    missingXSeenYLegacy: await read('notes/x-missing', true),
    seenX: await read('notes/x-seen', false),
    hiddenXHiddenY: await read('notes/x-hidden-y-hidden', false),
    hiddenXHiddenYLegacy: await read('notes/x-hidden-y-hidden', true),
    missingXHiddenY: await read('notes/x-missing-y-hidden', false),
    missingXHiddenYLegacy: await read('notes/x-missing-y-hidden', true),
  };
}

function expectCallerAnswers(got: Awaited<ReturnType<typeof callerReads>>): void {
  // (a) No page at X and Y visible answers Y; X hidden to the caller answers nothing, never Y in its place.
  expect(got.missingXSeenY).toBe('target');
  expect(got.missingXSeenYLegacy).toBe('target');
  expect(got.hiddenXSeenY).toBeNull();
  expect(got.hiddenXSeenYLegacy).toBeNull();
  // (b) X visible to the caller keeps its identity.
  expect(got.seenX).toBe('self');
  // (c) X hidden and Y hidden answers nothing, as no page at X with Y hidden does.
  expect(got.missingXHiddenY).toBeNull();
  expect(got.missingXHiddenYLegacy).toBeNull();
  expect(got.hiddenXHiddenY).toBe(got.missingXHiddenY);
  expect(got.hiddenXHiddenYLegacy).toBe(got.missingXHiddenYLegacy);
}

/** The read a remote caller makes under `c`'s record, through the engine's own member. */
const callerEngineRead = (engine: BrainEngine, c: Caller) => (slug: string, legacy: boolean) =>
  withCallerAccess(c.access, async () => answer(slug, await engine.readPageSnapshot(slug, {
    ...SOURCE_READS, requireUnambiguous: legacy, excludePrivate: true,
  })));

type RustStore = { readPageSnapshot(slug: string, scope: object): Promise<{ page: { source_id: string; slug: string } } | null> };
const rustStore = (engine: BrainEngine): RustStore =>
  (engine as unknown as { openStore(member: string): { brain: RustStore } }).openStore('readPageSnapshot').brain;

const SOURCE_PAIR = ['default', 'other'] as const;

/**
 * Which caller records the Rust store's page policy expresses. The rest (an audience of several members, an owner's
 * lineage read) are refused before any read, so they never reach the store's exact-slug check. When the store learns
 * one of them, this list changes and the case above then asserts that caller's answers. (The trunk store also serves
 * a labelled-only member, which the sync-21 master tree still listed as refused.)
 */
const RUST_CALLER_POLICY = {
  served: ['a named member', 'a labelled-only member', 'a caller with a private-readable grant for the source'],
  refused: ['an audience of two members', 'an owner read'],
};

/** Where the legacy read lands in a brain with two allowed sources: the page's source and `self` or `target`, or `ambiguous`. */
function answerIn(asked: string, got: { page: { source_id: string; slug: string } } | null): string | null {
  const a = answer(asked, got);
  return a === null ? null : `${got!.page.source_id}:${a}`;
}
const isAmbiguity = (e: unknown): boolean => e instanceof PageSnapshotAmbiguousError || /Multiple readable pages/.test(String((e as Error)?.message));

/**
 * Two allowed sources. In `default`, X holds a hidden page (case `h`) or nothing (case `m`), and X is an alias of a
 * readable page. In `other`, variant 1: a readable page at X; variant 2: X is an alias of another readable page.
 */
async function seedTwoSources(engine: BrainEngine, backend: ParityBackend): Promise<void> {
  await createSource(engine, backend, 'other');
  for (const [set, hiddenInDefault] of [['h', true], ['m', false]] as const) {
    for (const variant of ['page', 'alias'] as const) {
      const x = `notes/${set}-${variant}-x`;
      await aliasOf(engine, x, `notes/${set}-${variant}-y`);
      if (hiddenInDefault) await engine.putPage(x, page(`${x} itself`, { visibility: 'private' }));
      if (variant === 'page') await engine.putPage(x, page(`${x} in other`), { sourceId: 'other' });
      else await aliasOf(engine, x, `notes/${set}-alias-y-other`, {}, 'other');
    }
  }
}

type LegacyRead = (slug: string, scope: { sourceId: string } | { sourceIds: readonly string[]; requireUnambiguous: true }) => Promise<string | null>;

async function twoSourceReads(read: LegacyRead) {
  const out: Record<string, string | null> = {};
  for (const set of ['h', 'm']) {
    for (const variant of ['page', 'alias']) {
      const x = `notes/${set}-${variant}-x`;
      out[`${set}-${variant}-legacy`] = await read(x, { sourceIds: SOURCE_PAIR, requireUnambiguous: true });
      out[`${set}-${variant}-in-default`] = await read(x, { sourceId: 'default' });
      out[`${set}-${variant}-in-other`] = await read(x, { sourceId: 'other' });
    }
  }
  return out;
}

function expectTwoSourceAnswers(got: Record<string, string | null>): void {
  for (const variant of ['page', 'alias']) {
    // In `default`, hidden X answers nothing (its alias target never stands in); missing X answers the alias.
    expect(got[`h-${variant}-in-default`]).toBeNull();
    expect(got[`m-${variant}-in-default`]).toBe('default:target');
    expect(got[`m-${variant}-legacy`]).toBe('ambiguous');
    // `other` answers alike whatever `default` holds at X.
    expect(got[`h-${variant}-in-other`]).toBe(got[`m-${variant}-in-other`]);
  }
  expect(got['m-page-in-other']).toBe('other:self');
  expect(got['m-alias-in-other']).toBe('other:target');
  // A legacy read across both sources finds only `other`'s answer: the hidden page in `default` adds no candidate.
  expect(got['h-page-legacy']).toBe('other:self');
  expect(got['h-alias-legacy']).toBe('other:target');
}

function remoteOpContext(engine: BrainEngine): OperationContext {
  return { engine, config: { engine: engine.kind, embedding_disabled: true } as never, remote: true, sourceId: 'default',
    auth: { allowedSources: [...SOURCE_PAIR], hasSourceGrant: true }, dryRun: false, logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
}

async function fetchCode(engine: BrainEngine, id: string): Promise<string> {
  try { await operationsByName.fetch!.handler(remoteOpContext(engine), { id }); return 'read'; }
  catch (e) {
    const code = String((e as { code?: unknown }).code ?? (e as Error).message);
    if (code === 'engine_capability_missing') throw e; // a typed refusal stops the Rust arm; it is not an answer
    return code;
  }
}

describe('engine parity: a hidden page at an aliased slug fails closed', () => {
  parityTest(
    'a private page at an aliased slug answers nothing to a remote read, never the alias target in its place',
    { methods: ['putPage', 'updateSlug', 'readPageSnapshot'] },
    async (engine) => {
      await aliasOf(engine, 'notes/never-written', 'notes/target-missing');
      await aliasWithPage(engine, 'notes/hidden-private', 'notes/target-private', { visibility: 'private' });
      await aliasWithPage(engine, 'notes/open-twin', 'notes/target-open', {});
      const got = await reads(engineRead(engine), 'notes/hidden-private', 'notes/never-written', 'notes/open-twin');
      expectHiddenFailsClosed(got);
      return got;
    },
  );

  parityTest(
    'a page that names other readers at an aliased slug answers nothing to a remote read, never the alias target',
    { methods: ['putPage', 'updateSlug', 'readPageSnapshot'] },
    async (engine) => {
      await aliasOf(engine, 'notes/never-written', 'notes/target-missing');
      await aliasWithPage(engine, 'notes/hidden-readers', 'notes/target-readers', { readable_by: ['bob-example'] });
      await aliasWithPage(engine, 'notes/open-twin', 'notes/target-open', {});
      const got = await reads(engineRead(engine), 'notes/hidden-readers', 'notes/never-written', 'notes/open-twin');
      expectHiddenFailsClosed(got);
      return got;
    },
  );


  // One case per caller record: the caller's own filter decides which pages are hidden.
  parityTest(
    'for a named member, a hidden page at an aliased slug answers nothing, a visible one itself',
    { methods: ['putPage', 'updateSlug', 'readPageSnapshot'] },
    async (engine) => {
      await seedCaller(engine, CALLERS[0]!);
      const got = await callerReads(callerEngineRead(engine, CALLERS[0]!));
      expectCallerAnswers(got);
      return got;
    },
  );

  parityTest(
    'for a labelled-only member, a hidden page at an aliased slug answers nothing, a visible one itself',
    { methods: ['putPage', 'updateSlug', 'readPageSnapshot'] },
    async (engine) => {
      await seedCaller(engine, CALLERS[1]!);
      const got = await callerReads(callerEngineRead(engine, CALLERS[1]!));
      expectCallerAnswers(got);
      return got;
    },
  );

  parityTest(
    'for an audience of two members, a hidden page at an aliased slug answers nothing, a visible one itself',
    { methods: ['putPage', 'updateSlug', 'readPageSnapshot'] },
    async (engine) => {
      await seedCaller(engine, CALLERS[2]!);
      const got = await callerReads(callerEngineRead(engine, CALLERS[2]!));
      expectCallerAnswers(got);
      return got;
    },
  );

  parityTest(
    'for an owner read, a hidden page at an aliased slug answers nothing, a visible one itself',
    { methods: ['putPage', 'updateSlug', 'readPageSnapshot'] },
    async (engine) => {
      await seedCaller(engine, CALLERS[3]!);
      const got = await callerReads(callerEngineRead(engine, CALLERS[3]!));
      expectCallerAnswers(got);
      return got;
    },
  );

  parityTest(
    'for a caller with a private-readable grant, a hidden page at an aliased slug answers nothing, a visible one itself',
    { methods: ['putPage', 'updateSlug', 'readPageSnapshot'] },
    async (engine) => {
      await seedCaller(engine, CALLERS[4]!);
      const got = await callerReads(callerEngineRead(engine, CALLERS[4]!));
      expectCallerAnswers(got);
      return got;
    },
  );

  parityTest(
    'over two allowed sources, a hidden page at an aliased slug answers nothing in its source and adds no candidate',
    { methods: ['putPage', 'updateSlug', 'readPageSnapshot'] },
    async (engine, backend) => {
      await seedTwoSources(engine, backend);
      const got = await twoSourceReads(async (slug, scope) => {
        try {
          return answerIn(slug, await engine.readPageSnapshot(slug, { ...SOURCE_READS, ...scope, sourceId: undefined, ...('sourceId' in scope ? { sourceId: scope.sourceId } : {}), excludePrivate: true } as never));
        } catch (e) {
          if (isAmbiguity(e)) return 'ambiguous';
          throw e;
        }
      });
      expectTwoSourceAnswers(got);
      return got;
    },
  );

  parityTest(
    'over two allowed sources, fetch by a legacy id opens the other source\'s page past a hidden one, never its alias target',
    { methods: ['putPage', 'updateSlug', 'readPageSnapshot'] },
    async (engine, backend) => {
      await seedTwoSources(engine, backend);
      const got = {
        hiddenPage: await fetchCode(engine, 'notes/h-page-x'), missingPage: await fetchCode(engine, 'notes/m-page-x'),
        hiddenAlias: await fetchCode(engine, 'notes/h-alias-x'), missingAlias: await fetchCode(engine, 'notes/m-alias-x'),
      };
      expect(got).toEqual({ hiddenPage: 'read', missingPage: 'ambiguous_id', hiddenAlias: 'read', missingAlias: 'ambiguous_id' });
      return got;
    },
  );

  parityTest(
    'fetch of a hidden page\'s id at a slug with a readable stale alias gives the plain not-found, never the alias target',
    { methods: ['putPage', 'updateSlug', 'readPageSnapshot'] },
    async (engine) => {
      await aliasWithPage(engine, 'notes/hidden-cited', 'notes/stale-target', { visibility: 'private' });
      await aliasWithPage(engine, 'notes/readers-cited', 'notes/stale-target-readers', { readable_by: ['bob-example'] });
      const got = {
        hidden: await fetchCode(engine, encodeDeepResearchId('default', 'notes/hidden-cited')),
        readers: await fetchCode(engine, encodeDeepResearchId('default', 'notes/readers-cited')),
        nothing: await fetchCode(engine, encodeDeepResearchId('default', 'notes/no-page-no-alias')),
        target: await fetchCode(engine, encodeDeepResearchId('default', 'notes/stale-target')),
      };
      expect(got).toEqual({ hidden: 'page_not_found', readers: 'page_not_found', nothing: 'page_not_found', target: 'read' });
      return got;
    },
  );

  // A parity case counts a typed refusal as a pass, and the Rust member refuses these options, so this reads the store.
  test('the Rust store answers nothing for a hidden page at an aliased slug, never the alias target', async () => {
    const arm = arms().find((a) => a.backend === 'rust');
    if (!arm) return; // GBRAIN_TEST_RUST_ARM is off: nothing to read
    await resetArm(arm);
    const engine = arm.engine;
    await aliasOf(engine, 'notes/never-written', 'notes/target-missing');
    await aliasWithPage(engine, 'notes/hidden-private', 'notes/target-private', { visibility: 'private' });
    await aliasWithPage(engine, 'notes/hidden-readers', 'notes/target-readers', { readable_by: ['bob-example'] });
    await aliasWithPage(engine, 'notes/open-twin', 'notes/target-open', {});
    const store = (engine as unknown as { openStore(member: string): { brain: { readPageSnapshot(slug: string, scope: object): Promise<{ page: { slug: string } } | null> } } })
      .openStore('readPageSnapshot').brain;
    const policy = storePagePolicy('readPageSnapshot', true);
    const read: Read = async (slug, remote, legacy) => answer(slug, await store.readPageSnapshot(slug, {
      ...SOURCE_READS, requireUnambiguous: legacy, ...(remote ? { excludePrivate: policy } : {}),
    }));
    for (const hidden of ['notes/hidden-private', 'notes/hidden-readers']) {
      expectHiddenFailsClosed(await reads(read, hidden, 'notes/never-written', 'notes/open-twin'));
    }
  });
  // The Rust store gets the policy each caller's record renders. A caller whose policy the store cannot express is
  // refused before any read, so such a caller never reaches the store's exact-slug check; it is pinned by name.
  test('the Rust store answers as the SQL engines do for each caller record, or refuses the caller by name', async () => {
    const arm = arms().find((a) => a.backend === 'rust');
    if (!arm) return;
    const served: string[] = [];
    const refused: string[] = [];
    for (const c of CALLERS) {
      await resetArm(arm);
      await seedCaller(arm.engine, c);
      let policy: ReturnType<typeof storePageTextPolicy>;
      try {
        policy = withCallerAccess(c.access, () => storePageTextPolicy('readPageSnapshot', () => privatePagesFilterForCaller('p'), { callerReaders: true }));
      } catch (e) {
        expect(String((e as Error).message)).toContain('excludePrivate for a caller whose member pages, grants or lineage widen the policy');
        refused.push(c.name);
        continue;
      }
      const store = rustStore(arm.engine);
      expectCallerAnswers(await callerReads(async (slug, legacy) => answer(slug, await store.readPageSnapshot(slug, {
        ...SOURCE_READS, requireUnambiguous: legacy, excludePrivate: policy,
      }))));
      served.push(c.name);
    }
    expect({ served, refused }).toEqual(RUST_CALLER_POLICY);
  });

  test('the Rust store answers a hidden page over two allowed sources as the SQL engines do, adding no candidate', async () => {
    const arm = arms().find((a) => a.backend === 'rust');
    if (!arm) return;
    await resetArm(arm);
    await seedTwoSources(arm.engine, 'rust');
    const store = rustStore(arm.engine);
    const policy = storePagePolicy('readPageSnapshot', true);
    const got = await twoSourceReads(async (slug, scope) => {
      try {
        return answerIn(slug, await store.readPageSnapshot(slug, { ...SOURCE_READS, ...scope, excludePrivate: policy }));
      } catch (e) {
        if (isAmbiguity(e)) return 'ambiguous';
        throw e;
      }
    });
    expectTwoSourceAnswers(got);
  });
});
