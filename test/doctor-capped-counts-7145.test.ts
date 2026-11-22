/**
 * #7145: a doctor check that lists at most N rows reports N as a floor when more exist ("At least N", "N+",
 * exact: false), never as the exact count, and a scan that failed is not a clean result. PGLite in-memory, and
 * an isolated Postgres database when DATABASE_URL is set (test/postgres-unit-arms.txt); queue_health's
 * stalled and no-worker lists are Postgres-only (PGLite has its own queue summary).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { checkContentHashDuplicates } from '../src/commands/doctor/checks/extraction-sync.ts';
import { markdownBodyEntry } from '../src/commands/doctor/checks/data-integrity.ts';
import { contentSanityEntry } from '../src/commands/doctor/checks/content-quality.ts';
import { checkJunkEntityHubs } from '../src/commands/doctor/checks/graph-embedding.ts';
import { computeQueueHealthCheck } from '../src/commands/doctor/checks/queue-jobs.ts';
import { indexAuditEntry } from '../src/commands/doctor/checks/queue-assets.ts';
import { edgeValidityVerdict } from '../src/commands/doctor/checks/edge-validity.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const progress = new Proxy({}, { get: () => () => undefined });

for (const kind of testBackends()) describe(`doctor capped counts are floors (${kind})`, () => {
  let engine: BrainEngine;
  let close: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engine = lite; close = () => lite.disconnect(); }
  }, 120_000);
  afterAll(async () => { await close?.(); });

  async function withPages(prefix: string, n: number, body: string, extra: string, run: () => Promise<void>): Promise<void> {
    await engine.executeRaw(`INSERT INTO pages (slug, type, title, compiled_truth, content_hash)
      SELECT '${prefix}/' || lpad(i::text, 3, '0'), 'note', 'Example ' || i, $1, ${extra} FROM generate_series(1, $2::int) i`, [body, n]);
    try { await run(); } finally { await engine.executeRaw(`DELETE FROM pages WHERE slug LIKE '${prefix}/%'`); }
  }

  test('content_hash_duplicates past its 50-group read says at least 50', () => withPages('dup-a', 51, 'Same.', `'h-' || i`, () =>
    withPages('dup-b', 51, 'Same.', `'h-' || i`, async () => {
      const check = await checkContentHashDuplicates(engine);
      expect(check).toMatchObject({ status: 'warn', details: { hash_groups: 50, exact: false, limit: 50 } });
      expect(check.message).toContain('At least 50 duplicate-content group(s)');
    })));

  test('markdown_body_completeness past its 100-page list says at least 100', () => withPages('cut', 101, 'Short.', 'NULL', async () => {
    const content = `# Title\n\n## Part one\n\n${'Long body text. '.repeat(100)}`;
    await engine.executeRaw(`INSERT INTO raw_data (page_id, source, data) SELECT id, 'test', jsonb_build_object('content', $1::text) FROM pages WHERE slug LIKE 'cut/%'`, [content]);
    const [check] = (await markdownBodyEntry.run({ engine, progress } as never) as Array<Record<string, any>>).filter(c => c.name === 'markdown_body_completeness');
    expect(check).toMatchObject({ status: 'warn', details: { count: 100, exact: false, limit: 100 } });
    expect(check.message).toContain('At least 100 page(s) appear truncated');
  }));

  test('oversized_pages past its 100-page list says at least 100', () => withPages('big', 101, 'x'.repeat(400), 'NULL', async () => {
    await engine.setConfig('content_sanity.bytes_block', '200');
    try {
      const [check] = (await contentSanityEntry.run({ engine, progress, args: [] } as never) as Array<Record<string, any>>).filter(c => c.name === 'oversized_pages');
      expect(check).toMatchObject({ status: 'warn', details: { count: 100, exact: false, limit: 100 } });
      expect(check.message).toContain('At least 100 page(s) exceed the 200-byte');
    } finally { await engine.unsetConfig('content_sanity.bytes_block'); }
  }));

  test('junk_entity_hubs past its 20-page list says 20+', () => withPages('hub', 22, 'Hub.', 'NULL', async () => {
    await engine.executeRaw(`INSERT INTO links (from_page_id, to_page_id, link_type)
      SELECT p.id, q.id, 'mentions' FROM pages p JOIN pages q ON q.slug = 'hub/022' WHERE p.slug LIKE 'hub/%' AND p.slug <> 'hub/022'`);
    const check = await checkJunkEntityHubs(engine, { edgeThreshold: 0, maxChunks: 0 });
    expect(check).toMatchObject({ status: 'warn', details: { exact: false, limit: 20 } });
    expect(check.message).toContain('20+ near-empty page(s)');
  }));

  if (kind === 'postgres') {
    test('index_audit finds a live invalid partitioned index with no scan counter', async () => {
      const audit = async () => {
        const result = await indexAuditEntry.run({ engine, progress, args: ['--index-audit'] } as never);
        if (!Array.isArray(result) || result.length !== 1) throw new Error('Expected one index audit result');
        return result[0]!;
      };
      const baseline = await audit();
      expect(baseline).toMatchObject({ status: 'warn', details: { unusable_count: 0, exact: false } });

      await engine.executeRaw('CREATE TABLE audit_partition (id int) PARTITION BY RANGE (id)');
      try {
        await engine.executeRaw('CREATE TABLE audit_partition_child PARTITION OF audit_partition FOR VALUES FROM (0) TO (10)');
        await engine.executeRaw('CREATE INDEX audit_partition_incomplete_idx ON ONLY audit_partition (id)');
        const [catalog] = await engine.executeRaw<{ valid: boolean; indexed: boolean }>(`
          SELECT i.indisvalid AS valid, s.indexrelid IS NOT NULL AS indexed
            FROM pg_index i LEFT JOIN pg_stat_user_indexes s USING (indexrelid)
           WHERE i.indexrelid = 'audit_partition_incomplete_idx'::regclass
        `);
        expect(catalog).toEqual({ valid: false, indexed: false });

        const check = await audit();
        expect(check).toMatchObject({
          status: 'warn',
          details: {
            exact: false,
            zero_scan_total: baseline.details?.zero_scan_total,
            unusable_count: 1,
            unusable_indexes: [{ name: 'audit_partition_incomplete_idx' }],
          },
        });
        expect(check.message).toContain('1 live public index(es) are invalid or not ready');
      } finally {
        await engine.executeRaw('DROP TABLE audit_partition');
      }
    });

    test('queue_health counts every stalled job and finds the no-worker queue behind five with workers', async () => {
      await engine.executeRaw(`INSERT INTO minion_jobs (submission_authority, name, queue, status, started_at) SELECT '{}'::jsonb, 'example-job', 'q-stall', 'active', now() - interval '2 hours' FROM generate_series(1, 7)`);
      await engine.executeRaw(`INSERT INTO minion_jobs (submission_authority, name, queue, status, created_at)
        SELECT '{}'::jsonb, 'embed-backfill', 'q-' || i, 'waiting', now() - make_interval(hours => 10 - i) FROM generate_series(1, 6) i`);
      try {
        const check = await computeQueueHealthCheck(engine, { oldWaitingHours: 1, readWorkers: () => [1, 2, 3, 4, 5].map(i => ({ queue: `q-${i}` })) });
        expect(check.status).not.toBe('ok');
        expect(check.message).toContain('7 stalled-forever job(s) (oldest 5 listed)');
        expect(check.message).toContain("queue 'q-6'");
      } finally { await engine.executeRaw("DELETE FROM minion_jobs WHERE queue = 'q-stall' OR queue LIKE 'q-%'"); }
    });
  }
});

test('edge_validity marks a capped stale-assertion list as a floor', () => {
  const verdict = edgeValidityVerdict({ read_policy: 'on', contradiction_mode: 'propose', relationships: {}, lagging: 0,
    stale_assertions: [{ slug: 'people/alice-example', target: 'companies/acme-example', link_type: 'works_at', ended: '2025-01-01' }],
    stale_assertions_capped: true, proposals: { proposed: 0, undated: 0, applied: 0 } } as never);
  expect(verdict.message).toContain('1+ page(s) still state a relationship');
});
