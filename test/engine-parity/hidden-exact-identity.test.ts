/**
 * BrainEngine parity: a page the caller may not see reads exactly as a page that does not exist, on a read that
 * follows slug aliases and keeps an exact slug's identity (the remote `fetch` read: `readPageSnapshot` with
 * `excludePrivate`, `resolveAlias`, `requireLiveSource` and `preserveExactIdentity`).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: for a slug X that is an alias of a visible page Y, a remote read of X answers Y when X holds no page,
 *    and answers Y when X holds a page the caller may not see (`visibility: private`, or `readable_by` naming another
 *    member). Only a page at X the caller may see keeps its own identity and answers itself. A trusted local read
 *    (no `excludePrivate`) is unchanged: any page at X answers itself.
 *  - Regression: a remote read whose existence check for X ignores the caller's visibility. It answers nothing for X
 *    when X holds a hidden page and Y when X holds no page, so the caller could tell a page it may not see from a page
 *    that does not exist.
 *  - Why existing coverage misses it: no parity case reads a slug that is both an alias and (hidden) page, and the
 *    alias cases in pages.test.ts and sync-aliases.test.ts never pass `excludePrivate`.
 *  - Seam: none for the parity cases (typed methods only; the alias is made by renaming a page, then the old slug is
 *    written again). The Rust arm's `readPageSnapshot` member does not carry these options yet and stops on that typed
 *    refusal, which a parity case counts as a pass, so a plain test reads the Rust store through its own handle with
 *    the options and policy the SQL arms use and must return the same answers.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { PageInput } from '../../src/core/types.ts';
import { storePagePolicy } from '../../src/core/rust-engine/store-members/private-provenance.ts';
import { parityArms, resetArm } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest, arms } = parityArms(testBackends());

const page = (title: string, frontmatter: Record<string, unknown> = {}): PageInput =>
  ({ type: 'note', title, compiled_truth: `About ${title}.`, timeline: '', frontmatter });

/** `from` becomes an alias of `to`: the page is written under `from`, then renamed. */
async function aliasOf(engine: BrainEngine, from: string, to: string): Promise<void> {
  await engine.putPage(from, page(to));
  expect(await engine.updateSlug(from, to)).toBe(1);
}

/** `slug` is an alias of a visible page and ALSO holds a page with `frontmatter` (written after the rename). */
async function aliasWithPage(engine: BrainEngine, slug: string, target: string, frontmatter: Record<string, unknown>): Promise<void> {
  await aliasOf(engine, slug, target);
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

function expectHiddenReadsAsMissing(got: Awaited<ReturnType<typeof reads>>): void {
  expect(got.missingRemote).toBe('target');
  expect(got.missingRemoteLegacy).toBe('target');
  expect(got.hiddenRemote).toBe(got.missingRemote);
  expect(got.hiddenRemoteLegacy).toBe(got.missingRemoteLegacy);
  // A page the caller may see keeps its identity, and a trusted local read sees every page at the slug.
  expect(got.visibleRemote).toBe('self');
  expect(got.hiddenLocal).toBe('self');
}

describe('engine parity: a hidden page at an aliased slug reads as a missing page', () => {
  parityTest(
    'a private page at an aliased slug reads as missing to a remote read, not as the page itself being absent',
    { methods: ['putPage', 'updateSlug', 'readPageSnapshot'] },
    async (engine) => {
      await aliasOf(engine, 'notes/never-written', 'notes/target-missing');
      await aliasWithPage(engine, 'notes/hidden-private', 'notes/target-private', { visibility: 'private' });
      await aliasWithPage(engine, 'notes/open-twin', 'notes/target-open', {});
      const got = await reads(engineRead(engine), 'notes/hidden-private', 'notes/never-written', 'notes/open-twin');
      expectHiddenReadsAsMissing(got);
      return got;
    },
  );

  parityTest(
    'a page that names other readers at an aliased slug reads as missing to a remote read',
    { methods: ['putPage', 'updateSlug', 'readPageSnapshot'] },
    async (engine) => {
      await aliasOf(engine, 'notes/never-written', 'notes/target-missing');
      await aliasWithPage(engine, 'notes/hidden-readers', 'notes/target-readers', { readable_by: ['bob-example'] });
      await aliasWithPage(engine, 'notes/open-twin', 'notes/target-open', {});
      const got = await reads(engineRead(engine), 'notes/hidden-readers', 'notes/never-written', 'notes/open-twin');
      expectHiddenReadsAsMissing(got);
      return got;
    },
  );

  // A parity case counts a typed refusal as a pass, and the Rust member refuses these options, so this reads the store.
  test('the Rust store answers a hidden page at an aliased slug as it answers a missing page', async () => {
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
      expectHiddenReadsAsMissing(await reads(read, hidden, 'notes/never-written', 'notes/open-twin'));
    }
  });
});
