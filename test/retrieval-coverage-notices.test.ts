/**
 * #7165: coverage notices (`projection_pending`, `held_files`) are scoped to the
 * query and rate-limited. A pending projection or a held file that cannot match
 * this query drops the human-facing line but stays in `_meta.retrieval.coverage`
 * (and `projection_pending` in `_meta.retrieval.degraded`);
 * one that can match prints with its count. A repeat of the same state is
 * suppressed per session (stdio/HTTP session ledger) and, for one-shot CLI calls,
 * per GBRAIN_HOME window; a worsening or a new source prints again at once.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import type { Notice } from '../src/core/agent-output.ts';
import { writeGitHold } from '../src/core/persistence/sync-holds.ts';
import { NoticeLedger, __resetProcessNoticeLedgerForTests } from '../src/core/notice-ledger.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { captureRetrievalMeta, formatResult, resetRetrievalMetaForTests } from '../src/cli/main.ts';
import { applyCliOpNotices, captureOpNotice } from '../src/cli/op-notices.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
let engine: BrainEngine;
const search = operations.find(op => op.name === 'search')!;
const home = mkdtempSync(join(tmpdir(), 'gbrain-coverage-notices-'));
const env = { GBRAIN_HOME: home, GBRAIN_PROJECTION_READINESS_CACHE: '0' };
const QUERY = 'acme-example renewal';
/** The documented window: a shown coverage state stays shown for 30 minutes. */
const WINDOW_MS = 30 * 60 * 1000;

async function page(slug: string, type: string, title: string, text: string, sourceId = 'default') {
  await engine.putPage(slug, { type, title, compiled_truth: text, frontmatter: {} } as never, { sourceId } as never);
  await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_text: text, chunk_source: 'compiled_truth' }], { sourceId });
}

const pending = (slug: string, sourceId = 'default') =>
  engine.executeRaw('UPDATE pages SET text_projection_revision = NULL WHERE slug = $1 AND source_id = $2', [slug, sourceId]);

/** A large page (over the inline limit) whose embedding budget is held: no vectors. */
async function embeddingHeldPage(sourceId: string, slug: string, type: string, title: string, embedSkip: string | null = null) {
  await page(slug, type, title, 'a long recording transcript', sourceId);
  await engine.executeRaw(`UPDATE pages SET compiled_truth = repeat('x', 1100000),
    frontmatter = CASE WHEN $3::text IS NULL THEN frontmatter ELSE COALESCE(frontmatter, '{}'::jsonb) || jsonb_build_object('embed_skip', $3::text) END
    WHERE slug = $1 AND source_id = $2`, [slug, sourceId, embedSkip]);
  await engine.executeRaw('UPDATE pages SET text_projection_revision = knowledge_revision WHERE slug = $1 AND source_id = $2', [slug, sourceId]);
  await engine.executeRaw(`INSERT INTO page_embedding_budget(page_id, state, reason) SELECT id, 'held', 'upgrade_backfill' FROM pages WHERE slug = $1 AND source_id = $2`, [slug, sourceId]);
}

async function hold(sourceId: string, path: string) {
  const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id = $1', [sourceId]);
  await engine.transaction(tx => writeGitHold(tx, {
    source_id: sourceId, incarnation, path, source_path: path, slug: null, page_id: null, code: 'invalid_frontmatter',
    message: 'synthetic hold', upstream_version: null, observed_at: new Date().toISOString(), run_id: null, mode: 'legacy',
    meta: { recovery_version: 1 },
  } as never));
}

interface Call { ctx: OperationContext; notices: Notice[]; meta: Record<string, any> }
function call(sourceId: string): Call {
  const notices: Notice[] = [], meta: Record<string, any> = {};
  const ctx = {
    engine, config: { engine: 'pglite', embedding_disabled: true }, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, sourceId,
    emitNotice: (notice: Notice) => { notices.push(notice); },
    emitResponseMeta: (key: string, value: unknown) => { meta[key] = value; },
  } as unknown as OperationContext;
  return { ctx, notices, meta };
}

/** Runs `fn` once per backend (PGLite, and Postgres when DATABASE_URL is set) with `engine` bound. */
const eachEngine = (fn: () => Promise<void>) => () => withEnv(env, async () => {
  for (const each of engines) { engine = each; await fn(); }
});

beforeAll(async () => {
  const backends = testBackends();
  if (backends.includes('pglite')) {
    const pglite = new PGLiteEngine(); await pglite.connect({}); await pglite.initSchema(); engines.push(pglite);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close;
  }
  for (const each of engines) {
    engine = each;
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.setConfig('search.mcp_keyword_only', 'true');
    await engine.executeRaw("INSERT INTO sources(id,name,config) VALUES ('held-a','held-a','{}'), ('embed-a','embed-a','{}') ON CONFLICT DO NOTHING");
    for (const sourceId of ['default', 'held-a', 'embed-a']) {
      await page('companies/acme-example', 'company', 'Acme-example', 'acme-example renewal pricing and the contract terms', sourceId);
      await page('notes/acme-example-call', 'note', 'Acme-example call', 'acme-example renewal call notes from the review', sourceId);
    }
    await page('media/scan-0001', 'image', 'Scan 0001', 'a receipt scan from the archive');
    await pending('media/scan-0001');
  }
}, 120_000);

afterAll(async () => {
  for (const each of engines) if (each.kind === 'pglite') await each.disconnect();
  await closePostgres?.();
  rmSync(home, { recursive: true, force: true });
}, 60_000);

describe('projection_pending is scoped to the query', () => {
  test('a pending page that cannot match keeps the structured stage and counts but no human-facing line', eachEngine(async () => {
    const c = call('default');
    const results = await search.handler(c.ctx, { query: QUERY }) as Array<{ slug: string }>;
    expect(results.length).toBeGreaterThan(0);
    const retrieval = c.meta.retrieval;
    expect(retrieval.projection_readiness.status).toBe('projection_pending');
    expect(retrieval.degraded).toContainEqual({ stage: 'projection_pending' });
    expect(retrieval.coverage).toEqual({ pending_projection: 1, could_affect: { pending_projection: 0 } });
    expect(String(retrieval.hint ?? '')).not.toContain('projections are pending');
    captureRetrievalMeta('retrieval', retrieval);
    try { expect(formatResult('search', results, {})).not.toContain('Retrieval incomplete'); } finally { resetRetrievalMetaForTests(); }
  }));

  test('a pending page whose type or title matches keeps the stage and says how many could match', eachEngine(async () => {
    await page('notes/acme-example-plan', 'note', 'Acme-example renewal plan', 'acme-example renewal plan draft');
    await pending('notes/acme-example-plan');
    try {
      const c = call('default');
      await search.handler(c.ctx, { query: QUERY });
      expect(c.meta.retrieval.coverage).toEqual({ pending_projection: 2, could_affect: { pending_projection: 1 } });
      expect(c.meta.retrieval.degraded).toContainEqual({ stage: 'projection_pending' });
    } finally {
      await engine.executeRaw("UPDATE pages SET deleted_at = now() WHERE slug = 'notes/acme-example-plan'");
    }
  }));

  test('an empty result counts every pending page: it cannot be ruled out', eachEngine(async () => {
    const c = call('default');
    expect(await search.handler(c.ctx, { query: 'zzqv-absent-term' })).toEqual([]);
    expect(c.meta.retrieval.coverage).toEqual({ pending_projection: 1, could_affect: { pending_projection: 1 } });
    expect(c.meta.retrieval.degraded).toContainEqual({ stage: 'projection_pending' });
  }));

  test('an exact top hit whose projection is current drops projection_pending from the human-facing line (top_hit_exact)', eachEngine(async () => {
    await page('notes/acme-example-plan', 'note', 'Acme-example renewal plan', 'acme-example renewal plan draft');
    await pending('notes/acme-example-plan');
    // The exact-lookup tier runs on the hybrid path, which keyword-only search skips.
    await engine.setConfig('search.mcp_keyword_only', 'false');
    try {
      const c = call('default');
      const results = await search.handler(c.ctx, { query: 'companies/acme-example' }) as Array<{ slug: string; exact_lookup?: string }>;
      expect(results[0]).toMatchObject({ slug: 'companies/acme-example', exact_lookup: 'slug' });
      expect(c.meta.retrieval.coverage).toEqual({ pending_projection: 2, could_affect: { pending_projection: 0 }, top_hit_exact: true });
      expect(c.meta.retrieval.degraded).toContainEqual({ stage: 'projection_pending' });
      expect(String(c.meta.retrieval.hint ?? '')).not.toContain('projections are pending');
      captureRetrievalMeta('retrieval', c.meta.retrieval);
      try { expect(formatResult('search', results, {})).not.toContain('Retrieval incomplete'); } finally { resetRetrievalMetaForTests(); }
    } finally {
      await engine.executeRaw("UPDATE pages SET deleted_at = now() WHERE slug = 'notes/acme-example-plan'");
      await engine.setConfig('search.mcp_keyword_only', 'true');
    }
  }));

  test('an exact top hit that is itself pending keeps projection_pending counted', eachEngine(async () => {
    await pending('companies/acme-example');
    await engine.setConfig('search.mcp_keyword_only', 'false');
    try {
      const c = call('default');
      const results = await search.handler(c.ctx, { query: 'companies/acme-example' }) as Array<{ slug: string }>;
      expect(results[0]?.slug).toBe('companies/acme-example');
      expect(c.meta.retrieval.coverage.top_hit_exact).toBeUndefined();
      expect(c.meta.retrieval.coverage.could_affect.pending_projection).toBeGreaterThan(0);
    } finally {
      await engine.executeRaw("UPDATE pages SET text_projection_revision = knowledge_revision WHERE slug = 'companies/acme-example' AND source_id = 'default'");
      await engine.setConfig('search.mcp_keyword_only', 'true');
    }
  }));

  test('the query --types scope counts pending pages of those types', eachEngine(async () => {
    const c = call('default');
    await search.handler(c.ctx, { query: QUERY, types: ['image', 'company'] });
    expect(c.meta.retrieval.coverage).toEqual({ pending_projection: 1, could_affect: { pending_projection: 1 } });
  }));
});

describe('held_files is scoped to the query', () => {
  test('a held file that cannot match emits no notice; held_files and coverage still carry it', eachEngine(async () => {
    await hold('held-a', 'notes/unrelated-scan.md');
    const c = call('held-a');
    const results = await search.handler(c.ctx, { query: QUERY }) as unknown[];
    expect(results.length).toBeGreaterThan(0);
    expect(c.meta.retrieval.held_files).toEqual([{ source_id: 'held-a', missing: 1, stale: 0 }]);
    expect(c.meta.retrieval.coverage).toEqual({ held_files: 1, could_affect: { held_files: 0 } });
    expect(c.notices.find(n => n.code === 'held_files')).toBeUndefined();
  }));

  test('a held file whose path matches the query emits the notice with how many could match', eachEngine(async () => {
    await hold('held-a', 'notes/acme-example-renewal-draft.md');
    const c = call('held-a');
    await search.handler(c.ctx, { query: QUERY });
    expect(c.meta.retrieval.coverage).toEqual({ held_files: 2, could_affect: { held_files: 1 } });
    const notice = c.notices.find(n => n.code === 'held_files')!;
    expect(notice.kind).toBe('degraded');
    expect(notice.why).toContain('Coverage is partial: sync holds 2 file(s)');
    expect(notice.why).toContain('1 of them could match this query');
  }));
});

describe('pages held from embedding are named in coverage and the held_files line', () => {
  test('an embedding-held page that cannot match is counted in coverage with no notice', eachEngine(async () => {
    await embeddingHeldPage('embed-a', 'media/recording-0001', 'transcript', 'Recording 0001');
    const c = call('embed-a');
    expect((await search.handler(c.ctx, { query: QUERY }) as unknown[]).length).toBeGreaterThan(0);
    expect(c.meta.retrieval.coverage).toEqual({ embedding_held: 1, could_affect: { embedding_held: 0 } });
    expect(c.notices.find(n => n.code === 'held_files')).toBeUndefined();
  }));

  test('an embedding-held page that could match puts it in the held_files line with the read-only preview', eachEngine(async () => {
    await embeddingHeldPage('embed-a', 'notes/acme-example-renewal-recording', 'note', 'Acme-example renewal recording');
    const c = call('embed-a');
    await search.handler(c.ctx, { query: QUERY });
    expect(c.meta.retrieval.coverage).toEqual({ embedding_held: 2, could_affect: { embedding_held: 1 } });
    const notice = c.notices.find(n => n.code === 'held_files')!;
    expect(notice.why).toContain('2 page(s) in this scope are held from embedding');
    expect(notice.why).toContain('1 of them could match this query');
    expect(notice.fix).toMatchObject({ argv: ['gbrain', 'embed', '--held', '--dry-run'], actor: 'agent' });
  }));

  test('an embed_skip page with an applying budget row is not counted: no embedding path releases it', eachEngine(async () => {
    await embeddingHeldPage('embed-a', 'notes/acme-example-renewal-held', 'note', 'Acme-example renewal held');
    const before = call('embed-a');
    await search.handler(before.ctx, { query: QUERY });
    const counted = before.meta.retrieval.coverage;
    expect(counted.could_affect.embedding_held).toBeGreaterThan(0);
    await embeddingHeldPage('embed-a', 'notes/acme-example-renewal-skipped', 'note', 'Acme-example renewal skipped', 'content_sanity');
    const c = call('embed-a');
    await search.handler(c.ctx, { query: QUERY });
    expect(c.meta.retrieval.coverage).toEqual(counted);
  }));
});

describe('repeat suppression and worsening (session ledger)', () => {
  const notice = (level: number, key = 'source-a'): Notice =>
    ({ code: 'held_files', kind: 'degraded', why: 'synthetic', escalation: { key, level } }) as Notice;

  test('a repeat within the window is suppressed; a material rise, a new key or the window end prints again', () => {
    let now = 1_000;
    const ledger = new NoticeLedger(() => now);
    const stdio = { transport: 'stdio' as const };
    expect(ledger.admit([notice(100)], stdio)).toHaveLength(1);
    expect(ledger.admit([notice(100)], stdio)).toHaveLength(0);
    expect(ledger.admit([notice(105)], stdio)).toHaveLength(0);
    expect(ledger.admit([notice(110)], stdio)).toHaveLength(1);
    expect(ledger.admit([notice(3, 'source-b')], stdio)).toHaveLength(1);
    expect(ledger.admit([notice(110)], stdio)).toHaveLength(0);
    now += WINDOW_MS;
    expect(ledger.admit([notice(110)], stdio)).toHaveLength(1);
  });

  test('a drop then a rise from the lower level prints: worsening is measured from the lowest level since it showed', () => {
    const ledger = new NoticeLedger(() => 0);
    const stdio = { transport: 'stdio' as const };
    expect(ledger.admit([notice(100)], stdio)).toHaveLength(1);
    expect(ledger.admit([notice(20)], stdio)).toHaveLength(0);
    expect(ledger.admit([notice(22)], stdio)).toHaveLength(1);
  });

  test('a notice without escalation is unchanged: per-call held_files rides every call', () => {
    const ledger = new NoticeLedger(() => 0);
    const plain: Notice = { code: 'held_files', kind: 'degraded', why: 'synthetic' };
    expect(ledger.admit([plain], { transport: 'stdio' })).toHaveLength(1);
    expect(ledger.admit([plain], { transport: 'stdio' })).toHaveLength(1);
  });

  test('HTTP dedupes per transport-resolved session only; without one every call shows', () => {
    const ledger = new NoticeLedger(() => 0);
    const bare = { transport: 'http' as const, principal: 'client-a' };
    expect(ledger.admit([notice(5)], bare)).toHaveLength(1);
    expect(ledger.admit([notice(5)], bare)).toHaveLength(1);
    const session = { ...bare, sessionId: 'session-1' };
    expect(ledger.admit([notice(5)], session)).toHaveLength(1);
    expect(ledger.admit([notice(5)], session)).toHaveLength(0);
    expect(ledger.admit([notice(5)], { ...bare, sessionId: 'session-2' })).toHaveLength(1);
  });
});

describe('MCP dispatch: one stdio session', () => {
  const blocks = (r: { content: Array<{ text?: string }> }) => r.content.map(c => c.text ?? '').join('\n');

  test('the held_files notice shows once per session while _meta.retrieval.coverage rides every call', eachEngine(async () => {
    const opts = { remote: true, transport: 'stdio' as const, sourceId: 'held-a', noticeLedger: new NoticeLedger() };
    const first = await dispatchToolCall(engine, 'search', { query: QUERY }, opts) as any;
    const second = await dispatchToolCall(engine, 'search', { query: QUERY }, opts) as any;
    expect(blocks(first)).toContain('[gbrain notice held_files');
    expect(blocks(first)).toContain('1 of them could match this query');
    expect(blocks(second)).not.toContain('[gbrain notice held_files');
    for (const r of [first, second]) expect(r._meta.retrieval.coverage).toEqual({ held_files: 2, could_affect: { held_files: 1 } });
    await hold('held-a', 'notes/acme-example-renewal-v2.md');
    const worse = await dispatchToolCall(engine, 'search', { query: QUERY }, opts) as any;
    expect(blocks(worse)).toContain('[gbrain notice held_files');
    expect(worse._meta.retrieval.coverage).toEqual({ held_files: 3, could_affect: { held_files: 2 } });
  }));

  test('a pending page that cannot match adds no degraded_recall notice', eachEngine(async () => {
    const r = await dispatchToolCall(engine, 'search', { query: QUERY }, { remote: true, transport: 'stdio' as const, sourceId: 'default', noticeLedger: new NoticeLedger() }) as any;
    expect(r._meta.retrieval.degraded).toContainEqual({ stage: 'projection_pending' });
    expect(r._meta.retrieval.coverage).toEqual({ pending_projection: 1, could_affect: { pending_projection: 0 } });
    expect(blocks(r)).not.toContain('[gbrain notice degraded_recall');
  }));

  test('a projection_pending degraded_recall names the count and shows once per session', eachEngine(async () => {
    const opts = { remote: true, transport: 'stdio' as const, sourceId: 'default', noticeLedger: new NoticeLedger() };
    const first = await dispatchToolCall(engine, 'search', { query: 'zzqv-absent-term' }, opts) as any;
    const second = await dispatchToolCall(engine, 'search', { query: 'zzqv-absent-term' }, opts) as any;
    expect(blocks(first)).toContain('[gbrain notice degraded_recall');
    expect(blocks(first)).toContain('recently written pages are being indexed and are not in the search index yet (1 of 1 pending page(s) could match this query)');
    expect(blocks(second)).not.toContain('[gbrain notice degraded_recall');
    expect(second._meta.retrieval.degraded).toContainEqual({ stage: 'projection_pending' });
    expect(second._meta.retrieval.coverage).toEqual({ pending_projection: 1, could_affect: { pending_projection: 1 } });
  }));
});

describe('CLI: one-shot calls share a GBRAIN_HOME window', () => {
  const cliHome = () => mkdtempSync(join(tmpdir(), 'gbrain-coverage-cli-'));
  const meta = (total: number, could: number) => ({ degraded: [{ stage: 'projection_pending' }], coverage: { pending_projection: total, could_affect: { pending_projection: could } } });
  const row = [{ slug: 'notes/synthetic', score: 1, chunk_text: 'Synthetic note' }];

  test('the Retrieval incomplete line names the count, is suppressed on repeat and prints again when it worsens', () => withEnv({ GBRAIN_HOME: cliHome() }, async () => {
    try {
      captureRetrievalMeta('retrieval', meta(5, 2));
      expect(formatResult('query', row, {})).toContain('Retrieval incomplete: projection_pending. 2 of 5 pending page(s) could match this query.');
      captureRetrievalMeta('retrieval', meta(5, 2));
      expect(formatResult('query', row, {})).not.toContain('Retrieval incomplete');
      captureRetrievalMeta('retrieval', meta(9, 2));
      expect(formatResult('query', row, {})).toContain('Retrieval incomplete: projection_pending. 2 of 9 pending page(s) could match this query.');
    } finally { resetRetrievalMetaForTests(); }
  }));

  test('--json keeps the bare array and writes the scoped line to stderr once', () => withEnv({ GBRAIN_HOME: cliHome() }, async () => {
    const write = spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      captureRetrievalMeta('retrieval', meta(4, 4));
      expect(JSON.parse(formatResult('search', [], { json: true }))).toEqual([]);
      captureRetrievalMeta('retrieval', meta(4, 4));
      formatResult('search', [], { json: true });
      const lines = write.mock.calls.map(c => String(c[0])).filter(s => s.startsWith('Retrieval incomplete'));
      expect(lines).toEqual(['Retrieval incomplete: projection_pending. 4 of 4 pending page(s) could match this query.\n']);
    } finally { write.mockRestore(); resetRetrievalMetaForTests(); }
  }));

  test('an escalating op notice is suppressed in the next CLI process and shown again when it worsens', () => withEnv({ GBRAIN_HOME: cliHome() }, async () => {
    const held = (level: number): Notice => ({ code: 'held_files', kind: 'degraded', why: 'Coverage is partial: sync holds ' + level + ' file(s)', escalation: { key: 'source-a', level } } as Notice);
    const run = (level: number) => {
      __resetProcessNoticeLedgerForTests();
      captureOpNotice(held(level));
      return applyCliOpNotices([], false).stderr ?? '';
    };
    expect(run(3)).toContain('held_files');
    expect(run(3)).toBe('');
    expect(run(4)).toContain('held_files');
  }));
});
