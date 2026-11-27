/**
 * BrainEngine parity — mention coverage for a caller that may not read private pages (mentions/coverage.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: for an `excludePrivate` caller (a world-only remote caller), coverage is the same whether a private
 *    page exists or not, on every branch of the read: a source with no status row (its live pages), a saved count
 *    of 0 (the pages due since that count), a saved count above 0 (a whole-source due count the caller may read,
 *    never saved), and a row another binary counted (the recount saves the whole-source count as before, and the
 *    caller gets its own count). The callers pass the flag: get_backlinks, the entity card, entity-names and a
 *    search that names an entity emit no `mention_index` notice for a remote caller when only private pages are due.
 *    A local caller counts every live page, as before.
 *  - Regression: coverage counted the private pages a remote caller cannot read, so a new private page moved its
 *    pending_pages (2 to 3) or flipped `complete` to `pending`, and the caller learned that the page exists.
 *  - Why existing coverage misses it: test/engine-parity/mention-coverage.test.ts pinned the remote count with the
 *    private pages in it, and only on the no-row branch.
 *  - Seam: none. Real engines, typed members only (no executeRaw: D18). Status rows are written with
 *    writeMentionIndexStatus, the member the mention pass writes them with. "Missing" is the same brain after the
 *    private pages are soft-deleted.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { PageInput } from '../../src/core/types.ts';
import type { Notice } from '../../src/core/agent-output.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { operations } from '../../src/core/operations.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { readMentionCoverage, type MentionCoverage } from '../../src/core/mentions/coverage.ts';
import { INDEX_VERSION_STAMP } from '../../src/core/mentions/pass.ts';
import { buildEntityCard } from '../../src/core/verbs/entity-card.ts';
import { lookupEntityNames } from '../../src/core/verbs/entity-names.ts';

const { parityTest } = parityArms(testBackends());

const ACME = 'companies/acme-example';
const PRIVATE = ['notes/secret', 'notes/hidden'];

function page(title: string, extra: Partial<PageInput> = {}): PageInput {
  return { type: 'note', title, compiled_truth: `${title} body`, timeline: '', ...extra };
}

/** Acme (a company, also called Acme Co, so a search naming it fans out) and two world notes that name it: 3 world pages in `default`. */
async function seedWorld(engine: BrainEngine): Promise<void> {
  await engine.putPage(ACME, page('Acme Example', { type: 'company', compiled_truth: 'Acme Example builds widgets.' }));
  await engine.setPageAliases(ACME, 'default', ['acme co']);
  await engine.putPage('notes/one', page('One', { compiled_truth: 'Met Acme Example about the discount.' }));
  await engine.putPage('notes/two', page('Two', { compiled_truth: 'Acme Example discount follow-up.' }));
  await engine.addLinksBatch(['notes/one', 'notes/two'].map(from => ({ from_slug: from, to_slug: ACME, link_type: 'mentions', context: 'Acme Example',
    link_source: 'manual', from_source_id: 'default', to_source_id: 'default' })));
}

/** Two private pages in `default`, one of them naming Acme. */
async function seedPrivate(engine: BrainEngine): Promise<void> {
  await engine.putPage(PRIVATE[0]!, page('Secret', { compiled_truth: 'Secret about Acme Example.', frontmatter: { visibility: 'private' } }));
  await engine.putPage(PRIVATE[1]!, page('Hidden', { frontmatter: { visibility: 'private' } }));
}

async function dropPrivate(engine: BrainEngine): Promise<void> {
  for (const slug of PRIVATE) await engine.softDeletePage(slug, { sourceId: 'default' });
}

/** A status row as the pass writes it: `pending` saved now, with this binary's version stamp unless `stamp` says otherwise. */
async function writeStatus(engine: BrainEngine, state: 'complete' | 'pending', pending: number, stamp = INDEX_VERSION_STAMP): Promise<void> {
  await engine.writeMentionIndexStatus('default', { state, pending, lastPassAt: '2026-01-01T00:00:00.000Z', error: null, bumpGeneration: false,
    fingerprint: `h;${stamp}`, setFingerprint: true });
}

const remote = (engine: BrainEngine) => readMentionCoverage(engine, ['default'], { excludePrivate: true }).then(view);
const local = (engine: BrainEngine) => readMentionCoverage(engine, ['default']).then(view);

type View = { state: string; pending_pages: number; degraded: boolean | null };
const view = (c: MentionCoverage): View => ({ state: c.state, pending_pages: c.pending_pages, degraded: c.degraded ?? null });
const COMPLETE: View = { state: 'complete', pending_pages: 0, degraded: null };
const pending = (n: number): View => ({ state: 'pending', pending_pages: n, degraded: true });

function ctxFor(engine: BrainEngine, notices: Notice[], isRemote: boolean): OperationContext {
  const base = { engine, config: { engine: engine.kind }, remote: false, dryRun: false, sourceId: 'default',
    logger: { info() {}, warn() {}, error() {} }, emitNotice: (n: Notice) => { notices.push(n); } };
  return (isRemote ? { ...base, remote: true, transport: 'stdio', takesHoldersAllowList: ['world'] } : base) as unknown as OperationContext;
}

describe('engine parity: mention coverage for a caller that may not read private pages', () => {
  parityTest(
    'a source with no status row: the remote caller counts the live pages it may read, the same as with no private page',
    { methods: ['putPage', 'setPageAliases', 'addLinksBatch', 'softDeletePage', 'readMentionIndexStatus', 'countLivePagesInSource'] },
    async (engine: BrainEngine) => {
      await seedWorld(engine);
      await seedPrivate(engine);
      const hidden = { remote: await remote(engine), local: await local(engine) };
      await dropPrivate(engine);
      const missing = { remote: await remote(engine), local: await local(engine) };
      const out = { hidden, missing };
      expect(out).toEqual({ hidden: { remote: pending(3), local: pending(5) }, missing: { remote: pending(3), local: pending(3) } });
      return out;
    },
  );

  parityTest(
    'a saved count of 0: a private page written since then leaves the remote caller complete, the same as with no private page',
    { methods: ['putPage', 'setPageAliases', 'addLinksBatch', 'softDeletePage', 'writeMentionIndexStatus', 'readMentionIndexStatus', 'countMentionDueSince'] },
    async (engine: BrainEngine) => {
      await seedWorld(engine);
      await writeStatus(engine, 'complete', 0);
      const before = { remote: await remote(engine), local: await local(engine) };
      await seedPrivate(engine);
      const hidden = { remote: await remote(engine), local: await local(engine) };
      await dropPrivate(engine);
      const missing = { remote: await remote(engine), local: await local(engine) };
      const out = { before, hidden, missing };
      expect(out).toEqual({ before: { remote: COMPLETE, local: COMPLETE }, hidden: { remote: COMPLETE, local: pending(2) },
        missing: { remote: COMPLETE, local: COMPLETE } });
      return out;
    },
  );

  parityTest(
    'a saved count above 0: the remote caller gets the due pages it may read, and the saved count is not changed',
    { methods: ['putPage', 'setPageAliases', 'addLinksBatch', 'softDeletePage', 'writeMentionIndexStatus', 'readMentionIndexStatus', 'countMentionDueSince', 'countPagesDueForMentions'] },
    async (engine: BrainEngine) => {
      await seedWorld(engine);
      await seedPrivate(engine);
      // The pass saved the whole-source count: 3 world pages and 2 private pages, none scanned yet.
      await writeStatus(engine, 'pending', 5);
      const hidden = { remote: await remote(engine), local: await local(engine) };
      const saved = (await engine.readMentionIndexStatus(['default']))[0]?.pending;
      await dropPrivate(engine);
      await writeStatus(engine, 'pending', 3);
      const missing = { remote: await remote(engine), local: await local(engine) };
      const out = { hidden, saved: Number(saved), missing };
      expect(out).toEqual({ hidden: { remote: pending(3), local: pending(5) }, saved: 5, missing: { remote: pending(3), local: pending(3) } });
      return out;
    },
  );

  parityTest(
    'a row another binary counted: the recount saves the whole-source count as before, and the remote caller gets its own count',
    { methods: ['putPage', 'setPageAliases', 'addLinksBatch', 'softDeletePage', 'writeMentionIndexStatus', 'readMentionIndexStatus', 'countPagesDueForMentions', 'recountMentionIndexStatus'] },
    async (engine: BrainEngine) => {
      await seedWorld(engine);
      await seedPrivate(engine);
      await writeStatus(engine, 'complete', 0, 'v0.0');
      const hidden = await remote(engine);
      const row = (await engine.readMentionIndexStatus(['default']))[0];
      const savedAfterRemote = { pending: Number(row?.pending), fingerprint: row?.policy_fingerprint };
      const localAfter = await local(engine);
      await dropPrivate(engine);
      await writeStatus(engine, 'complete', 0, 'v0.0');
      const missing = await remote(engine);
      const out = { hidden, savedAfterRemote, localAfter, missing };
      expect(out).toEqual({ hidden: pending(3), savedAfterRemote: { pending: 5, fingerprint: `h;${INDEX_VERSION_STAMP}` },
        localAfter: pending(5), missing: pending(3) });
      return out;
    },
  );

  parityTest(
    'get_backlinks, the entity card, entity-names and search emit no mention_index notice for a remote caller when only private pages are due',
    { methods: ['putPage', 'setPageAliases', 'addLinksBatch', 'writeMentionIndexStatus', 'readMentionIndexStatus', 'countMentionDueSince'] },
    async (engine: BrainEngine) => {
      await seedWorld(engine);
      await writeStatus(engine, 'complete', 0);
      await seedPrivate(engine);
      const run = async (isRemote: boolean) => {
        const notices = { backlinks: [] as Notice[], names: [] as Notice[], search: [] as Notice[] };
        const backlinks = operations.find(o => o.name === 'get_backlinks')!;
        const b = await backlinks.handler(ctxFor(engine, notices.backlinks, isRemote), { slug: ACME, group: 'page' }) as { coverage: MentionCoverage };
        const card = await buildEntityCard(engine, 'default', 'Acme Example', { remote: isRemote, includeReferences: true });
        const miss = await buildEntityCard(engine, 'default', 'Nobody Example', { remote: isRemote, includeReferences: true });
        await lookupEntityNames(engine, 'default', ['Acme Example'], { remote: isRemote, emitNotice: n => { notices.names.push(n); } });
        await operations.find(o => o.name === 'search')!.handler(ctxFor(engine, notices.search, isRemote), { query: 'Acme Example discount' });
        const mentionIndex = (ns: Notice[]) => ns.filter(n => n.code === 'mention_index').length;
        return {
          backlinks: view(b.coverage),
          card: card.found && card.card?.coverage ? view(card.card.coverage) : null,
          miss: !miss.found && miss.coverage ? view(miss.coverage) : null,
          notices: { backlinks: mentionIndex(notices.backlinks), names: mentionIndex(notices.names), search: mentionIndex(notices.search) },
        };
      };
      const out = { remote: await run(true), local: await run(false) };
      expect(out).toEqual({
        remote: { backlinks: COMPLETE, card: COMPLETE, miss: COMPLETE, notices: { backlinks: 0, names: 0, search: 0 } },
        local: { backlinks: pending(2), card: pending(2), miss: pending(2), notices: { backlinks: 1, names: 1, search: 1 } },
      });
      return out;
    },
  );
});
