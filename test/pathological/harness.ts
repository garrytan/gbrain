/**
 * Shared pathological-state harness (GBRA-130). Each case builds one bad state
 * directly (PGLite always, Postgres when DATABASE_URL is set), runs it through
 * the unit it used to wedge, and asserts three things:
 *  1. the unit was not aborted (`expectUnitNotAborted`);
 *  2. the bad item is held or reported with a typed code and fix (`expectItemFailure`);
 *  3. no other item was lost or changed (`snapshotItems` before, `expectOthersUnchanged` after),
 * and, for the same site, that a run-scoped failure still stops the unit and holds nothing.
 *
 * Builders for other lanes' states live with those lanes; import this module
 * and add a builder next to your case. Register a new per-item site in
 * src/core/item-failure.ts ISOLATE_SITES and its cases in ./catalogue.ts.
 */
import { expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { classifyItemFailure, type ClassifiedItemFailure } from '../../src/core/item-failure.ts';
import { OperationError } from '../../src/core/ops/contract.ts';
import { requirePostgresTestDatabase, testBackends, type TestBackend } from '../helpers/test-backends.ts';

export { managedBrain } from '../helpers/managed-brain.ts';

/** The engine arms a pathological case runs on: PGLite, plus Postgres when the lane provides DATABASE_URL. */
export function pathologicalArms(): Array<{ backend: TestBackend; databaseUrl: string | undefined }> {
  return testBackends().map(backend => ({ backend, databaseUrl: backend === 'pglite' ? undefined : requirePostgresTestDatabase() }));
}

export interface ItemSnapshotRow {
  slug: string;
  content_hash: string | null;
  updated_at: string;
  deleted_at: string | null;
  links: number;
  chunks: number;
}

/** Every page of a source with what a wedge could lose or change: content, liveness, outgoing links and chunks. */
export async function snapshotItems(engine: BrainEngine, sourceId: string): Promise<Map<string, ItemSnapshotRow>> {
  const rows = await engine.executeRaw<ItemSnapshotRow>(
    `SELECT p.slug, p.content_hash, p.updated_at::text AS updated_at, p.deleted_at::text AS deleted_at,
            (SELECT count(*)::int FROM links l WHERE l.from_page_id = p.id) AS links,
            (SELECT count(*)::int FROM content_chunks c WHERE c.page_id = p.id) AS chunks
       FROM pages p WHERE p.source_id = $1 ORDER BY p.slug`, [sourceId]);
  return new Map(rows.map(row => [row.slug, row]));
}

/**
 * Every page outside `changed` is byte-for-byte what it was. `expectProgress`
 * lists pages the run had to change (the healthy siblings): each must differ
 * from `before` in at least one of the listed fields, so "nothing happened"
 * can't pass as "nothing was lost".
 */
export function expectOthersUnchanged(before: Map<string, ItemSnapshotRow>, after: Map<string, ItemSnapshotRow>,
  opts: { changed?: Iterable<string>; expectProgress?: Iterable<string>; progressFields?: Array<keyof ItemSnapshotRow> } = {}): void {
  const changed = new Set([...(opts.changed ?? []), ...(opts.expectProgress ?? [])]);
  for (const [slug, row] of before) {
    if (changed.has(slug)) continue;
    expect({ slug, row: after.get(slug) }).toEqual({ slug, row });
  }
  for (const slug of opts.expectProgress ?? []) {
    const fields = opts.progressFields ?? ['content_hash', 'updated_at', 'links', 'chunks'];
    const was = before.get(slug);
    const now = after.get(slug);
    expect(now).toBeDefined();
    expect({ slug, moved: fields.some(f => was?.[f] !== now?.[f]) }).toEqual({ slug, moved: true });
  }
}

/** The run returned (it did not throw) and reports a result: a wedge is a throw or a never-advancing cursor, never a quiet ok. */
export async function expectUnitNotAborted<T>(run: () => Promise<T>): Promise<T> {
  let thrown: unknown;
  let result: T | undefined;
  try { result = await run(); } catch (error) { thrown = error; }
  expect({ aborted: thrown === undefined ? null : (thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown)) }).toEqual({ aborted: null });
  return result as T;
}

/** A recorded item failure names its item and a typed code; `fix` (when given) is a command an agent can run. */
export function expectItemFailure(failure: { key?: string; slug?: string; item?: string; code?: string; reason?: string; fix?: unknown } | undefined,
  want: { key: string; code: string; fix?: RegExp }): void {
  expect(failure).toBeDefined();
  const key = failure!.key ?? failure!.item ?? failure!.slug;
  const code = failure!.code ?? failure!.reason;
  expect({ key, code }).toEqual({ key: want.key, code: want.code });
  if (want.fix) {
    const forms = [renderFix(failure!.fix), JSON.stringify(failure!.fix)];
    expect({ fix: forms[0], matches: forms.some(form => want.fix!.test(form)) }).toEqual({ fix: forms[0], matches: true });
  }
}

/** A fix as an agent reads it: an Action renders as its argv joined by spaces, a string stays as is. */
export function renderFix(fix: unknown): string {
  if (typeof fix === 'string') return fix;
  const argv = (fix as { argv?: unknown } | null)?.argv;
  return Array.isArray(argv) ? argv.join(' ') : JSON.stringify(fix);
}

/** Errors a run-scoped probe injects at a site: each must stop the unit and record no hold. */
export function runScopedErrors(): Array<{ name: string; error: () => unknown }> {
  const lost = () => Object.assign(new Error('Connection terminated unexpectedly'), { code: '08006' });
  const aborted = () => Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
  const failedTx = () => Object.assign(new Error('current transaction is aborted, commands ignored until end of transaction block'), { code: '25P02' });
  const owner = () => new OperationError('owner_unavailable', 'The canonical writer for this source is unavailable.');
  return [{ name: 'connection lost', error: lost }, { name: 'abort', error: aborted }, { name: 'failed transaction (25P02)', error: failedTx },
    { name: 'owner_unavailable', error: owner }];
}

/** Sanity: every injected run-scoped error classifies as run-scoped. */
export function classifyInjected(error: unknown): ClassifiedItemFailure { return classifyItemFailure(error); }
