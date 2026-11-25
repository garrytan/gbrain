/**
 * BrainEngine parity — the delete_page tool: a soft delete, a soft delete of a private origin, and a purge.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a soft delete through the delete_page handler answers the same status on every engine arm (PGLite
 *    always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1) and leaves the page soft-deleted.
 *    A soft delete of a private origin carries the label to its derived page (`derived_from`), so the digest reads
 *    `visibility: private` on every arm. A purge removes the page on PGLite and Postgres; on the Rust arm it ends on
 *    the pre-write purge-path refusal (persistence/purge-path-members.ts: engine_capability_missing naming the first
 *    member or raw-SQL site the Rust engine cannot serve and its owner lane), so nothing is written and the page is still live and unchanged.
 *  - Regression: on the Rust engine the origin carry read the origin and its dependents through raw SQL, and a silent
 *    `.catch(() => null)` dropped the refusal, so the soft delete committed and the digest of a private origin stayed
 *    world-visible. The Rust purge wrote a fallback soft delete and a `purge_held` record and only then failed.
 *  - Why existing coverage misses it: test/derived-origin-carry-private.test.ts runs on PGLite only, and no parity file
 *    drove delete_page.
 *  - The label door's members are also pinned directly: readPrivacyOrigin, listOriginDependents, readPageLabelRow and
 *    writePageLabelGuard over a private origin, its digest and a world page; listCheckoutFiles over a page with a recorded file in a source with
 *    a page with a recorded file in a source with a checkout, one in a source without, one with no file, a soft-deleted
 *    one, and an unknown id.
 *  - Seam: the delete_page operation handler, whole, with a local (trusted) caller and the arm's own persistence
 *    consumer. Revisions and times differ between arms, so they are folded out.
 */
import { afterEach, describe, expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { operationsByName, type OperationContext } from '../../src/core/operations.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { purgePathStops } from '../../src/core/persistence/purge-path-members.ts';
import { createSource, parityArms } from './harness.ts';
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

const page = (title: string, fm: string[]) =>
  ['---', `title: ${title}`, ...fm, '---', `# ${title}`, '', `Harbor ledger notes for ${title}.`].join('\n');

async function put(ctx: OperationContext, slug: string, content: string): Promise<void> {
  await operationsByName.put_page.handler(ctx, { slug, content, request_id: randomUUID() });
}

/** Whether the page exists, is soft-deleted, and its visibility label. */
async function state(engine: BrainEngine, slug: string): Promise<R> {
  const p = await engine.getPage(slug, { sourceId: SRC, includeDeleted: true }) as R | null;
  if (!p) return { exists: false };
  return { exists: true, deleted: p.deleted_at != null, visibility: (p.frontmatter as R | undefined)?.visibility ?? null };
}

async function deletePage(engine: BrainEngine, slug: string, extra: R = {}): Promise<R> {
  const snapshot = await engine.readPageSnapshot(slug, { sourceId: SRC });
  const r = await operationsByName.delete_page.handler(localCtx(engine), {
    slug, request_id: randomUUID(), expected_revision: snapshot?.revision, ...extra,
  }) as R;
  return { status: r.status ?? null, noop: r.noop ?? null, slug: r.slug, source_id: r.source_id ?? null, purged: r.purge != null };
}

describe('engine parity: delete_page', () => {
  parityTest('a soft delete answers the same and leaves the page soft-deleted', {
    methods: ['getPage', 'readPageSnapshot'],
    timeout: 120_000,
  }, async (engine) => {
    opened.push(engine);
    await put(localCtx(engine), 'notes/plain', page('plain', ['type: note']));
    const before = await state(engine, 'notes/plain');
    const outcome = await deletePage(engine, 'notes/plain');
    return { before, outcome, after: await state(engine, 'notes/plain') };
  });

  parityTest('a soft delete of a private origin labels its derived page private', {
    methods: ['readPrivacyOrigin', 'listOriginDependents', 'readPageLabelRow', 'writePageLabelGuard'],
    timeout: 120_000,
  }, async (engine) => {
    opened.push(engine);
    const ctx = localCtx(engine);
    await put(ctx, 'notes/origin', page('origin', ['type: note', 'visibility: private']));
    await put(ctx, 'notes/digest', page('digest', ['type: note', 'derived_from: notes/origin.md']));
    await put(ctx, 'notes/bystander', page('bystander', ['type: note']));
    const before = { origin: await state(engine, 'notes/origin'), digest: await state(engine, 'notes/digest') };
    const outcome = await deletePage(engine, 'notes/origin');
    return {
      before, outcome,
      after: {
        origin: await state(engine, 'notes/origin'),
        digest: await state(engine, 'notes/digest'),
        bystander: await state(engine, 'notes/bystander'),
      },
    };
  });

  parityTest('a purge removes the page; on the Rust engine it refuses before any write', {
    methods: ['getPage', 'readPageSnapshot'],
    requires: 'raw_sql',
    timeout: 120_000,
  }, async (engine, backend) => {
    opened.push(engine);
    await put(localCtx(engine), 'notes/doomed', page('doomed', ['type: note', 'visibility: private']));
    await put(localCtx(engine), 'notes/doomed-digest', page('doomed digest', ['type: note', 'derived_from: notes/doomed.md']));
    const before = { page: await state(engine, 'notes/doomed'), digest: await state(engine, 'notes/doomed-digest') };
    try {
      const outcome = await deletePage(engine, 'notes/doomed', { purge: true });
      return { before, outcome, after: { page: await state(engine, 'notes/doomed'), digest: await state(engine, 'notes/doomed-digest') } };
    } catch (error) {
      // The refusal must come before any write: the page and its digest read exactly as they did before, and it names
      // the first stop the purge-path list holds for this engine, with its owner lane.
      if ((error as { code?: string }).code === 'engine_capability_missing') {
        const [first] = await purgePathStops(engine);
        const refusal = error as { message?: string; detail?: string };
        expect({ backend, names: first ? [first.name, first.owner].filter(part => `${refusal.message} ${refusal.detail}`.includes(part)) : null })
          .toEqual({ backend, names: first ? [first.name, first.owner] : null });
        expect({ backend, page: await state(engine, 'notes/doomed'), digest: await state(engine, 'notes/doomed-digest'), tombstones: await engine.countPagePurgeTombstones(SRC, 'notes/doomed') })
          .toEqual({ backend, ...before, tombstones: 0 });
      }
      throw error;
    }
  });


  parityTest('the label door members answer directly: origin, dependents, label row and label guard', {
    methods: ['putPage', 'readPrivacyOrigin', 'listOriginDependents', 'readPageLabelRow', 'writePageLabelGuard'],
  }, async (engine) => {
    const note = { type: 'note' as const, compiled_truth: 'Harbor ledger notes.', timeline: '' };
    const origin = await engine.putPage('notes/secret', { ...note, title: 'secret', frontmatter: { visibility: 'private' } });
    const digest = await engine.putPage('notes/secret-digest', { ...note, title: 'digest', frontmatter: { derived_from: 'notes/secret.md' } });
    await engine.putPage('notes/open', { ...note, title: 'open' });
    const name = new Map([[Number(origin.id), 'origin'], [Number(digest.id), 'digest']]);
    const asOrigin = (row: { id: number; deleted: boolean } | null) => row && { id: name.get(row.id) ?? row.id, deleted: row.deleted };
    const label = async (slug: string) => {
      const row = await engine.readPageLabelRow(SRC, slug);
      return row && { id: name.get(row.id) ?? 'other', frontmatter: row.frontmatter };
    };
    const dependents = await engine.listOriginDependents([{ id: Number(origin.id), source_id: SRC, slug: 'notes/secret' }]);
    await engine.writePageLabelGuard(Number(digest.id), 'operator_curated');
    await engine.writePageLabelGuard(Number(digest.id), null);
    await engine.writePageLabelGuard(Number(digest.id), null);
    return {
      origin: asOrigin(await engine.readPrivacyOrigin(SRC, 'notes/secret')),
      world: await engine.readPrivacyOrigin(SRC, 'notes/open'),
      missing: await engine.readPrivacyOrigin(SRC, 'notes/nowhere'),
      dependents: dependents.map(d => ({ ...d, id: name.get(d.id) ?? d.id, cleared_id: name.get(d.cleared_id) ?? d.cleared_id })),
      none: await engine.listOriginDependents([]),
      labels: { origin: await label('notes/secret'), digest: await label('notes/secret-digest'), missing: await engine.readPageLabelRow(SRC, 'notes/nowhere') },
    };
  });
  parityTest('listCheckoutFiles answers each page with a recorded file, with its source checkout, by id', {
    methods: ['putPage', 'softDeletePage', 'listCheckoutFiles'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'checked', {}, '/brains/checked');
    await createSource(engine, backend, 'bare');
    const note = { type: 'note' as const, title: 'n', compiled_truth: 'Harbor ledger notes.', timeline: '' };
    const filed = await engine.putPage('notes/filed', { ...note, source_path: 'notes/filed.md' }, { sourceId: 'checked' });
    const bare = await engine.putPage('notes/bare', { ...note, source_path: 'notes/bare.md' }, { sourceId: 'bare' });
    const nofile = await engine.putPage('notes/nofile', note, { sourceId: 'checked' });
    const gone = await engine.putPage('notes/gone', { ...note, source_path: 'notes/gone.md' }, { sourceId: 'checked' });
    await engine.softDeletePage('notes/gone', { sourceId: 'checked' });
    const ids = [Number(gone.id), Number(nofile.id), Number(filed.id), Number(bare.id), Number(filed.id), 9_999_999];
    const rows = await engine.listCheckoutFiles(ids);
    const name = new Map([[Number(filed.id), 'filed'], [Number(bare.id), 'bare'], [Number(nofile.id), 'nofile'], [Number(gone.id), 'gone']]);
    expect(rows.map(r => r.id)).toEqual([...rows.map(r => r.id)].sort((a, b) => a - b));
    return { rows: rows.map(r => ({ ...r, id: name.get(r.id) })).sort((a, b) => String(a.id).localeCompare(String(b.id))), empty: await engine.listCheckoutFiles([]) };
  });
});
