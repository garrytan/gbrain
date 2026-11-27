/**
 * BrainEngine parity — `delete_page --purge` of a page with links, aliases and saved versions.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a trusted local purge through the delete_page handler answers the same on every engine arm (PGLite
 *    always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1): the same status, the same
 *    store-by-store `removed` counts and the same receipt, and it leaves the same rows: the page, its versions, its
 *    alias rows and its outgoing and incoming links are gone, its content hashes are tombstoned, and the page it
 *    linked to and the page that linked to it are live and unchanged.
 *  - Regression: the Rust engine refused every page purge (delete-page.test.ts, the raw_sql refusal in
 *    repair/origin-carry.ts), because the purge parked, swept and deleted through raw SQL.
 *  - Rust: the purge runs whole on the Rust engine (the typed purge members of persistence/purge-path-members.ts are all served, so
 *    purgePathStops is empty), and the case compares equal on all three arms with no stop and no refusal pin.
 *  - Why existing coverage misses it: delete-page.test.ts pins only the refusal on Rust; the page purge suites
 *    (test/page-purge*.test.ts) run on PGLite and Postgres only.
 *  - Seam: the delete_page and put_page operation handlers, whole, with a local (trusted) caller and the arm's own
 *    persistence consumer; the later versions and the links are written through the typed createVersion, putPage and addLink. Ids, request ids, revisions and times differ between arms, so they are folded out.
 */
import { afterEach, describe, expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { operationsByName, type OperationContext } from '../../src/core/operations.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const SRC = 'default';
const opened: BrainEngine[] = [];

afterEach(async () => {
  for (const engine of opened.splice(0)) await disposePersistenceConsumer(engine).catch(() => undefined);
});

type R = Record<string, unknown>;

function localCtx(engine: BrainEngine): OperationContext {
  return { engine, config: { engine: engine.kind }, logger: quiet, dryRun: false, remote: false, sourceId: SRC } as unknown as OperationContext;
}

const page = (title: string, fm: string[], body: string) => ['---', `title: ${title}`, 'type: note', ...fm, '---', `# ${title}`, '', body].join('\n');

async function put(engine: BrainEngine, slug: string, content: string): Promise<void> {
  await operationsByName.put_page.handler(localCtx(engine), { slug, content, request_id: randomUUID() });
}

/** What is left of one slug: the page row, its saved versions, its alias rows and its links each way. */
async function rowsOf(engine: BrainEngine, slug: string): Promise<R> {
  const p = await engine.getPage(slug, { sourceId: SRC, includeDeleted: true }) as R | null;
  const versions = await engine.getVersions(slug, { sourceId: SRC });
  const aliases = (await engine.readPageAliasRows([SRC], [slug])).map(a => a.alias_norm).sort();
  const out = (await engine.getLinks(slug, { sourceId: SRC })).map(l => l.to_slug).sort();
  const back = (await engine.getBacklinks(slug, { sourceId: SRC })).map(l => l.from_slug).sort();
  return { page: p ? { deleted: p.deleted_at != null, title: p.title } : null, versions: versions.length, aliases, out, back };
}

/** The receipt with ids and times folded out: each store's status and counts, in order. */
function receiptOf(r: R): R {
  const receipt = (r.receipt ?? null) as R | null;
  if (!receipt) return { receipt: null };
  const stores = (receipt.stores as R[] | undefined ?? []).map(s => ({ store: s.store, status: s.status, removed: s.removed ?? null, remaining: s.remaining ?? null, reason: s.reason ?? null }));
  const residuals = (receipt.residuals as R[] | undefined ?? []).map(s => ({ store: s.store, status: s.status, reason: s.reason ?? null }));
  return { stores, residuals, page_tombstones: receipt.page_tombstones ?? null, completion: receipt.completion ?? null };
}

describe('engine parity: page purge', () => {
  parityTest('a purge of a page with links, aliases and versions leaves the same rows and the same receipt on every engine', {
    methods: ['readPageSnapshot', 'createVersion', 'putPage', 'addLink', 'getPage', 'getVersions', 'readPageAliasRows', 'getLinks', 'getBacklinks', 'countPagePurgeTombstones'],
    timeout: 120_000,
  }, async (engine) => {
    opened.push(engine);
    await put(engine, 'notes/keeper', page('keeper', [], 'Keeper notes about the harbor.'));
    await put(engine, 'notes/doomed', page('doomed', ['aliases: [Doomed Alias, Old Harbor]'], 'First draft about the harbor.'));
    // Two saved versions, each of a different body, written through the typed createVersion and putPage: a put_page
    // rewrite versions the page with its preimage, which the Rust engine does not serve yet.
    for (const draft of ['Second', 'Third']) {
      await engine.createVersion('notes/doomed', { sourceId: SRC });
      const live = await engine.getPage('notes/doomed', { sourceId: SRC });
      await engine.putPage('notes/doomed', { type: 'note', title: 'doomed', compiled_truth: `# doomed\n\n${draft} draft about the harbor.`, timeline: '',
        frontmatter: live!.frontmatter }, { sourceId: SRC });
    }
    // The links are written through the typed addLink: link extraction on put_page is not served on the Rust engine yet.
    await engine.addLink('notes/doomed', 'notes/keeper', 'the doomed page cites the keeper', 'mentions');
    await engine.addLink('notes/keeper', 'notes/doomed', 'the keeper cites the doomed page', 'mentions');
    const before = { doomed: await rowsOf(engine, 'notes/doomed'), keeper: await rowsOf(engine, 'notes/keeper') };
    const snapshot = await engine.readPageSnapshot('notes/doomed', { sourceId: SRC });
    const purgeArgs = { slug: 'notes/doomed', purge: true, request_id: randomUUID(), expected_revision: snapshot?.revision };
    const r = await operationsByName.delete_page.handler(localCtx(engine), purgeArgs) as R;
    const purge = (r.purge ?? {}) as R;
    const outcome = { status: r.status, slug: r.slug, source_id: r.source_id, removed: purge.removed ?? null, tombstoned: purge.content_hashes_tombstoned ?? null,
      blobs: purge.blobs ?? null, journal_complete: (r.journal_sweep as R | undefined)?.complete ?? null };
    const after = {
      doomed: await rowsOf(engine, 'notes/doomed'), keeper: await rowsOf(engine, 'notes/keeper'),
      tombstones: await engine.countPagePurgeTombstones(SRC, 'notes/doomed'),
    };
    expect({ out: before.doomed.out, back: before.doomed.back, versions: before.doomed.versions }).toEqual({ out: ['notes/keeper'], back: ['notes/keeper'], versions: 2 });
    expect(after.doomed).toEqual({ page: null, versions: 0, aliases: [], out: [], back: [] });
    expect(after.keeper).toEqual({ ...before.keeper, out: [], back: [] });
    return { before, outcome, after, receipt: receiptOf(r) };
  });
});
