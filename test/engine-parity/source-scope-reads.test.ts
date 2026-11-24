/**
 * BrainEngine parity — the two source-scope checks every read op runs before it reads: `assertExplicitSourceLive`
 * (src/core/ops/context.ts, through `readSourceRow`) and `assertUnscopedReadReachesPages`
 * (src/core/sources-not-readable.ts, through `readSourcesNotReadable`).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: every engine arm judges a read's sources the same way. An explicit `source_id` that names a live
 *    source passes; one that names an archived or unknown source throws `unknown_source`; `__all__` and an omitted
 *    id skip the check; `recall` with an explicit live source answers
 *    that source's pages through the keyword-only fallback, and with an archived one fails
 *    `not_found`. An unscoped remote read with no
 *    source grant is refused with `sources_not_readable` exactly when its readable sources hold no live,
 *    unquarantined page it may read (for recall and query, no active world fact either) and another source that is
 *    not archived holds such a page; soft-deleted, quarantined and (under the remote read floor) private pages count
 *    on neither side, and a read that names a source or a connection granted sources is never refused.
 *  - Regression: an engine that cannot answer either check. On the Rust engine both checks were raw SQL: the explicit
 *    check stopped every read that names a source (recall's keyword fallback included) on a raw_sql refusal, and the
 *    unscoped check swallowed the refusal and never refused. Also an engine that counts deleted, quarantined or
 *    private pages, archived sources, or private and expired facts (the refusal then fires on a real miss, or never).
 *  - Why existing coverage misses it: test/mcp-sources-not-readable.test.ts drives the refusal through the HTTP server
 *    on PGLite and Postgres only, and no test runs `assertExplicitSourceLive` against the Rust engine.
 *    Through the MCP dispatcher: a remote recall or query with no source grant answers `sources_not_readable` while
 *    its source holds nothing it may read, and answers normally once a world fact (recall, query) or a page lands
 *    there; get_page with an explicit live source reads it, and one that names an archived or unknown source refuses
 *    `unknown_source` (ops/pages.ts, through assertExplicitSourceLive). The harness fails a Rust case that caught a typed refusal on the way, so the
 *    dispatcher's catch around the check cannot hide a refused read.
 *  - Seam: none. Real engines, the real op helpers and the real dispatcher; the remote caller is a plain
 *    OperationContext or dispatch auth.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/operations.ts';
import { operationsByName } from '../../src/core/operations.ts';
import { assertExplicitSourceLive } from '../../src/core/ops/context.ts';
import { assertUnscopedReadReachesPages } from '../../src/core/sources-not-readable.ts';
import type { PageInput } from '../../src/core/types.ts';
import { archiveSource, createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from '../helpers/with-env.ts';

const { parityTest } = parityArms(testBackends());

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

function localCtx(engine: BrainEngine): OperationContext {
  return { engine, config: { engine: engine.kind }, logger: quiet, dryRun: false, remote: false, sourceId: 'default' } as unknown as OperationContext;
}

function remoteCtx(engine: BrainEngine, auth: Record<string, unknown> = { hasSourceGrant: false }, extra: Record<string, unknown> = {}): OperationContext {
  return {
    engine, config: { engine: engine.kind }, logger: quiet, dryRun: false, remote: true, sourceId: 'default',
    auth: { clientId: 'parity', clientName: 'parity', scopes: ['read'], ...auth }, ...extra,
  } as unknown as OperationContext;
}

async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'ok';
  } catch (e) {
    return (e as { code?: string }).code ?? (e as Error).message;
  }
}

function page(frontmatter?: Record<string, unknown>): PageInput {
  return { type: 'note', title: 'Note', compiled_truth: 'A short note.', ...(frontmatter ? { frontmatter } : {}) };
}

async function withHome<T>(run: () => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-parity-source-scope-'));
  try { return await withEnv({ GBRAIN_HOME: home }, run); } finally { rmSync(home, { recursive: true, force: true }); }
}

describe('engine parity: source-scope checks', () => {
  parityTest('an explicit source_id passes only for a live source, and recall reads it', { methods: ['readSourceRow'] }, async (engine, backend) => {
    await createSource(engine, backend, 'live');
    await createSource(engine, backend, 'gone');
    await archiveSource(engine, backend, 'gone');
    await engine.putPage('notes/ledger', { type: 'note', title: 'Ledger', compiled_truth: 'The ledger moved to the harbour.' }, { sourceId: 'live' });
    await engine.sealChunks('notes/ledger', [{ chunk_index: 0, chunk_text: 'The ledger moved to the harbour.', chunk_source: 'compiled_truth' }], { sourceId: 'live' });
    await engine.putPage('notes/ledger-default', { type: 'note', title: 'Ledger', compiled_truth: 'The ledger stayed home.' }, { sourceId: 'default' });
    await engine.sealChunks('notes/ledger-default', [{ chunk_index: 0, chunk_text: 'The ledger stayed home.', chunk_source: 'compiled_truth' }], { sourceId: 'default' });
    const ctx = localCtx(engine);
    const checks: Record<string, string> = {};
    for (const id of ['live', 'default', 'gone', 'missing', '__all__', undefined]) {
      checks[String(id)] = await outcome(() => assertExplicitSourceLive(ctx, id));
    }
    expect(checks).toEqual({ live: 'ok', default: 'ok', gone: 'unknown_source', missing: 'unknown_source', __all__: 'ok', undefined: 'ok' });
    const recall = operationsByName.recall!.handler;
    // No embedding provider: recall's page arm takes the keyword-only fallback, scoped to the named source.
    const live = await recall(ctx, { query: 'ledger', source_id: 'live' }) as { results: { slug: string; source_id: string }[]; search_degraded?: string };
    const pages = { results: live.results.map((r) => `${r.source_id}:${r.slug}`), degraded: live.search_degraded };
    expect(pages).toEqual({ results: ['live:notes/ledger'], degraded: 'keyword_only_no_embedding_provider' });
    const gone = await outcome(() => recall(ctx, { query: 'ledger', source_id: 'gone' }));
    expect(gone).toBe('not_found');
    return { checks, pages, gone };
  });

  parityTest('through MCP, a remote recall or query with no grant is refused while its source shows nothing, and answers once it does',
    { methods: ['readSourcesNotReadable', 'insertFact'], timeout: 90_000 },
    async (engine, backend) => withHome(async () => {
      const auth = { token: 'parity', clientId: 'parity', clientName: 'parity', scopes: ['read'], hasSourceGrant: false } as never;
      const call = async (op: string, params: Record<string, unknown>) => {
        const result = await dispatchToolCall(engine, op, params, { remote: true, sourceId: 'default', auth });
        const text = result.content.map(part => (part as { text?: string }).text ?? '').join('');
        if (!result.isError) return 'answered';
        const code = /"(?:code|error)"\s*:\s*"([a-z_]+)"/.exec(text)?.[1];
        return code ?? text.slice(0, 120);
      };
      const reads = async () => ({ recall: await call('recall', { query: 'harbor schedule' }), query: await call('query', { query: 'harbor schedule' }) });
      await createSource(engine, backend, 'team');
      await engine.putPage('notes/team', page(), { sourceId: 'team' });
      const steps: Record<string, unknown> = {};
      steps.nothingReadable = await reads();
      await engine.insertFact({ fact: 'The harbor schedule moved to Friday.', entity_slug: null, visibility: 'world', source: 'test', embedding: null }, { source_id: 'default' });
      steps.worldFact = await reads();
      expect(steps).toEqual({
        nothingReadable: { recall: 'sources_not_readable', query: 'sources_not_readable' },
        worldFact: { recall: 'answered', query: 'answered' },
      });
      return steps;
    }));

  parityTest('through MCP, get_page with an explicit source_id reads a live source and refuses an archived one',
    { methods: ['readSourceRow'], timeout: 90_000 },
    async (engine, backend) => withHome(async () => {
      await createSource(engine, backend, 'team');
      await createSource(engine, backend, 'old');
      await engine.putPage('notes/live', page(), { sourceId: 'team' });
      await engine.putPage('notes/kept', page(), { sourceId: 'old' });
      await archiveSource(engine, backend, 'old');
      const get = async (slug: string, sourceId: string) => {
        const result = await dispatchToolCall(engine, 'get_page', { slug, source_id: sourceId }, { remote: false, sourceId: 'default' });
        const text = result.content.map(part => (part as { text?: string }).text ?? '').join('');
        return result.isError ? (/"(?:code|error)"\s*:\s*"([a-z_]+)"/.exec(text)?.[1] ?? text.slice(0, 120)) : (JSON.parse(text) as { slug?: string }).slug ?? 'read';
      };
      const steps = { live: await get('notes/live', 'team'), archived: await get('notes/kept', 'old'), unknown: await get('notes/live', 'missing-example') };
      expect(steps).toEqual({ live: 'notes/live', archived: 'unknown_source', unknown: 'unknown_source' });
      return steps;
    }));

  parityTest('an unscoped remote read with no source grant is refused only when its sources hold nothing it may read', { methods: ['readSourcesNotReadable'] }, async (engine, backend) => {
    const ctx = remoteCtx(engine);
    const verdicts = async (): Promise<Record<string, string>> => {
      const out: Record<string, string> = {};
      for (const op of ['search', 'list_pages', 'query', 'recall']) out[op] = await outcome(() => assertUnscopedReadReachesPages(op, { query: 'q' }, ctx));
      return out;
    };
    const steps: Record<string, Record<string, string>> = {};
    const all = (v: string) => ({ search: v, list_pages: v, query: v, recall: v });
    steps.empty = await verdicts();
    expect(steps.empty).toEqual(all('ok'));

    await createSource(engine, backend, 'team');
    await engine.putPage('notes/team', page(), { sourceId: 'team' });
    steps.otherHoldsAPage = await verdicts();
    expect(steps.otherHoldsAPage).toEqual(all('sources_not_readable'));

    // Pages in the readable source that do not count: soft-deleted, quarantined, private.
    await engine.putPage('notes/gone', page(), { sourceId: 'default' });
    await engine.softDeletePage('notes/gone', { sourceId: 'default' });
    await engine.putPage('notes/quarantined', page({ quarantine: 'held' }), { sourceId: 'default' });
    await engine.putPage('notes/private', page({ visibility: 'private' }), { sourceId: 'default' });
    steps.onlyHiddenPages = await verdicts();
    expect(steps.onlyHiddenPages).toEqual(all('sources_not_readable'));

    // A private fact does not count; an active world fact counts for recall and query only.
    await engine.insertFact({ fact: 'a private fact', entity_slug: null, visibility: 'private', source: 'test', embedding: null }, { source_id: 'default' });
    const world = await engine.insertFact({ fact: 'a world fact', entity_slug: null, visibility: 'world', source: 'test', embedding: null }, { source_id: 'default' });
    steps.worldFact = await verdicts();
    expect(steps.worldFact).toEqual({ search: 'sources_not_readable', list_pages: 'sources_not_readable', query: 'ok', recall: 'ok' });
    await engine.expireFact(world.id);
    steps.expiredFact = await verdicts();
    expect(steps.expiredFact).toEqual(all('sources_not_readable'));

    // Never refused: a read that names a source, a connection granted sources, a local caller.
    const never = {
      namesSource: await outcome(() => assertUnscopedReadReachesPages('search', { query: 'q', source_id: 'default' }, ctx)),
      granted: await outcome(() => assertUnscopedReadReachesPages('search', { query: 'q' }, remoteCtx(engine, { hasSourceGrant: true }))),
      allowed: await outcome(() => assertUnscopedReadReachesPages('search', { query: 'q' }, remoteCtx(engine, { allowedSources: ['default'] }))),
      local: await outcome(() => assertUnscopedReadReachesPages('search', { query: 'q' }, localCtx(engine))),
    };
    expect(never).toEqual({ namesSource: 'ok', granted: 'ok', allowed: 'ok', local: 'ok' });

    // A federated set that includes the source holding pages reads it.
    const federated = await outcome(() => assertUnscopedReadReachesPages('search', { query: 'q' }, remoteCtx(engine, { hasSourceGrant: false }, { localFederatedSourceIds: ['default', 'team'] })));

    // The other side counts only live, visible pages of sources that are not archived.
    await archiveSource(engine, backend, 'team');
    steps.otherArchived = await verdicts();
    expect(steps.otherArchived).toEqual(all('ok'));
    await createSource(engine, backend, 'other');
    await engine.putPage('notes/oq', page({ quarantine: 'held' }), { sourceId: 'other' });
    await engine.putPage('notes/op', page({ visibility: 'private' }), { sourceId: 'other' });
    steps.otherOnlyHidden = await verdicts();
    expect(steps.otherOnlyHidden).toEqual(all('ok'));
    await engine.putPage('notes/o', page(), { sourceId: 'other' });
    steps.otherVisible = await verdicts();
    expect(steps.otherVisible).toEqual(all('sources_not_readable'));
    return { steps, never, federated };
  });
});
