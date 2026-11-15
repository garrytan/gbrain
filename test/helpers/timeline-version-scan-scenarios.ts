/**
 * #9362: timeline retraction on a page with many stored versions. Shared by the PGLite unit test
 * (test/timeline-retract-version-scan.test.ts) and the Postgres E2E (test/e2e/timeline-retract-version-scan-postgres.test.ts).
 */
import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createConnection, createServer, type AddressInfo, type Socket } from 'node:net';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { withCoordinatedWrite } from '../../src/core/persistence/context.ts';
import { isTerminalWriteState } from '../../src/core/persistence/types.ts';
import { publishManagedPageTimeline } from '../../src/commands/extract-timeline-db.ts';
import { retractRemovedTimelineEntries, versionTimelineScan } from '../../src/core/timeline-extract.ts';
import { BodyReadStopped } from '../../src/core/page-body/segment-blocks.ts';
import { TEST_WRITE_ATTRIBUTION } from './write-attribution.ts';
import { managedBrain } from './managed-brain.ts';
import { conversationBody } from './conversation-page.ts';

export const SLUG = 'people/alice-example';
const KEPT = '- **2026-01-02** | test — Met Acme';
const REMOVED = '- **2026-02-03** | test — Joined Acme';
const ALSO_REMOVED = '- **2026-03-04** | test — Left Acme';

const put = async (ctx: OperationContext, body: string) => {
  const current = await ctx.engine.readPageSnapshot(SLUG, { sourceId: 'default' });
  return submitPageMutation(ctx, { operation: 'put_page', params: { slug: SLUG, request_id: randomUUID(),
    content: `---\ntype: person\ntitle: Alice\n---\n\n${body}\n`, ...(current ? { expected_revision: current.revision } : {}) } });
};

const guarded = <T>(engine: BrainEngine, fn: (tx: BrainEngine) => Promise<T>) =>
  engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => fn(tx), TEST_WRITE_ATTRIBUTION));

export const summaries = async (engine: BrainEngine) => (await engine.executeRaw<{ summary: string }>(
  `SELECT t.summary FROM timeline_entries t JOIN pages p ON p.id = t.page_id WHERE p.slug = $1 AND t.event_page_id IS NULL ORDER BY t.date, t.summary`, [SLUG]))
  .map(row => row.summary);

/** Stored rows the current text does not produce: two an earlier version held, one (enrichment) no version ever held. */
async function storeRows(engine: BrainEngine, rows: Array<[string, string]>) {
  await guarded(engine, tx => tx.executeRaw(`INSERT INTO timeline_entries (page_id, date, source, summary, detail)
    SELECT p.id, r.d::date, 'test', r.s, '' FROM pages p, jsonb_to_recordset($2::text::jsonb) AS r(d text, s text) WHERE p.slug = $1`,
  [SLUG, JSON.stringify(rows.map(([d, s]) => ({ d, s })))]));
}

/** A page whose first save held three bullets and whose two later saves hold one, with the removed rows stored again. */
async function smallPage(engine: BrainEngine, ctx: OperationContext) {
  await engine.setConfig('auto_link', 'false');
  await put(ctx, `A person.\n\n## Timeline\n\n${KEPT}\n${REMOVED}\n${ALSO_REMOVED}`);
  await put(ctx, `A person, edited.\n\n## Timeline\n\n${KEPT}`);
  await put(ctx, `A person, edited again.\n\n## Timeline\n\n${KEPT}`);
  await disposePersistenceConsumer(engine);
  await storeRows(engine, [['2026-02-03', 'Joined Acme'], ['2026-03-04', 'Left Acme'], ['2026-04-05', 'Enriched note']]);
  const [{ n }] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM page_versions v JOIN pages p ON p.id = v.page_id WHERE p.slug = $1', [SLUG]);
  expect(n).toBeGreaterThan(0);
  expect(await summaries(engine)).toEqual(['Met Acme', 'Joined Acme', 'Left Acme', 'Enriched note']);
}

/** Master's outcome on a small page: rows an earlier version produced are retracted, the rest stay. */
export async function smallPageRetractsLikeMaster(databaseUrl?: string) {
  await managedBrain(async ({ engine, ctx }) => {
    await smallPage(engine, ctx);
    await publishManagedPageTimeline(engine, SLUG, 'default');
    expect(await summaries(engine)).toEqual(['Met Acme', 'Enriched note']);
  }, { databaseUrl });
}

/**
 * The same outcome on a page now stored in segments: a row its inline history produced and a row only a retained
 * segmented generation produced are both retracted, a row no version produced stays.
 */
export async function segmentedPageRetractsLikeMaster(databaseUrl?: string) {
  await managedBrain(async ({ engine, ctx }) => {
    await engine.setConfig('auto_link', 'false');
    await engine.setConfig('pages.segmented_storage', 'on');
    const large = (bullets: string[]) => `${conversationBody(1_200_000, { seed: 41 })}\n\n${conversationBody(1_200_000, { seed: 42 })}\n\n## Timeline\n\n${bullets.join('\n')}`;
    await put(ctx, `A person.\n\n## Timeline\n\n${KEPT}\n${REMOVED}`);
    await put(ctx, large([KEPT, ALSO_REMOVED]));
    await put(ctx, large([KEPT]));
    await put(ctx, large([KEPT, '- **2026-06-07** | test — Joined again']));
    await put(ctx, large([KEPT]));
    await disposePersistenceConsumer(engine);
    const storage = await engine.executeRaw<{ body_storage: string }>(`SELECT DISTINCT v.body_storage FROM page_versions v JOIN pages p ON p.id = v.page_id
      WHERE p.slug = $1 ORDER BY 1`, [SLUG]);
    expect(storage.map(row => row.body_storage)).toEqual(['inline', 'segmented']);
    await storeRows(engine, [['2026-02-03', 'Joined Acme'], ['2026-03-04', 'Left Acme'], ['2026-04-05', 'Enriched note'], ['2026-06-07', 'Joined again']]);
    await publishManagedPageTimeline(engine, SLUG, 'default');
    expect(await summaries(engine)).toEqual(['Met Acme', 'Enriched note']);
  }, { databaseUrl });
}

const textOf = async (engine: BrainEngine) => {
  const [page] = await engine.executeRaw<{ compiled_truth: string; timeline: string | null }>('SELECT compiled_truth, timeline FROM pages WHERE slug = $1', [SLUG]);
  return `${page!.compiled_truth}\n${page!.timeline ?? ''}`;
};

const ids = (rows: Array<{ id: number }>) => JSON.stringify(rows.map(row => Number(row.id)));

/**
 * The retraction a scan read before the transaction makes is never more than a scan inside it would make (master's
 * read): an interrupted scan retracts nothing, a version rewritten or deleted since the scan vouches for nothing, and a
 * row the scan was not asked about stays.
 */
export async function scanBeforeTransactionNeverRetractsMore(databaseUrl?: string) {
  await managedBrain(async ({ engine, ctx }) => {
    await smallPage(engine, ctx);
    const before = await summaries(engine);
    const text = await textOf(engine);
    const holding = () => engine.executeRaw<{ id: number }>(`SELECT v.id FROM page_versions v JOIN pages p ON p.id = v.page_id
      WHERE p.slug = $1 AND strpos(v.compiled_truth || coalesce(v.timeline, ''), 'Left Acme') > 0`, [SLUG]);
    const inside = async () => (await guarded(engine, tx => retractRemovedTimelineEntries(tx, SLUG, 'default', text, { dryRun: true })))
      .map(row => row.summary);
    expect((await holding()).length).toBeGreaterThan(0);

    let reads = 0;
    const interrupted = versionTimelineScan();
    expect(await retractRemovedTimelineEntries(engine, SLUG, 'default', text, { versions: interrupted, stop: () => ++reads > 1 })
      .then(() => null, (error: unknown) => error)).toBeInstanceOf(BodyReadStopped);
    expect(reads).toBe(2);
    expect(interrupted.done).toBe(false);
    expect(await summaries(engine)).toEqual(before);

    const rewritten = versionTimelineScan();
    expect((await retractRemovedTimelineEntries(engine, SLUG, 'default', text, { dryRun: true, versions: rewritten })).map(row => row.summary))
      .toEqual(['Joined Acme', 'Left Acme']);
    const witnesses = ids(await holding());
    await guarded(engine, tx => tx.executeRaw(`UPDATE page_versions SET compiled_truth = replace(compiled_truth, $2, ''), timeline = replace(timeline, $2, '')
      WHERE id IN (SELECT jsonb_array_elements_text($1::text::jsonb)::int)`, [witnesses, REMOVED]));
    await storeRows(engine, [['2026-05-06', 'Added after the scan']]);
    expect(await inside()).toEqual(['Left Acme']);
    expect(await guarded(engine, tx => retractRemovedTimelineEntries(tx, SLUG, 'default', text, { versions: rewritten }))).toEqual([]);

    const deleted = versionTimelineScan();
    expect((await retractRemovedTimelineEntries(engine, SLUG, 'default', text, { dryRun: true, versions: deleted })).map(row => row.summary))
      .toEqual(['Left Acme']);
    await guarded(engine, tx => tx.executeRaw('DELETE FROM page_versions WHERE id IN (SELECT jsonb_array_elements_text($1::text::jsonb)::int)', [witnesses]));
    expect(await inside()).toEqual([]);
    expect(await guarded(engine, tx => retractRemovedTimelineEntries(tx, SLUG, 'default', text, { versions: deleted }))).toEqual([]);
    expect(await summaries(engine)).toEqual([...before, 'Added after the scan']);
  }, { databaseUrl });
}

/**
 * A TCP proxy to Postgres that delivers at most `bytesPerSecond` toward the client, as a remote managed database's link
 * does. Reading slower makes the server's send block, which the server's statement timeout still counts.
 */
async function throttledPostgres(databaseUrl: string, bytesPerSecond: number) {
  const target = new URL(databaseUrl);
  const sockets = new Set<Socket>();
  const server = createServer(client => {
    const upstream = createConnection({ host: target.hostname, port: Number(target.port || 5432) });
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => { client.destroy(); upstream.destroy(); });
    }
    client.pipe(upstream);
    let next = 0;
    upstream.on('data', (chunk: Buffer) => {
      client.write(chunk);
      next = Math.max(next, performance.now()) + chunk.length / bytesPerSecond * 1000;
      const wait = next - performance.now();
      if (wait > 1) { upstream.pause(); setTimeout(() => upstream.resume(), wait); }
    });
    upstream.on('end', () => client.end());
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const url = new URL(databaseUrl);
  url.hostname = '127.0.0.1';
  url.port = String((server.address() as AddressInfo).port);
  return { url: url.toString(), close: async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(done => server.close(() => done()));
  } };
}

/**
 * The reported shape (#9362): a page body of ~300 KB with 300 stored versions of about that size (~90 MB), a stored row
 * the current text does not produce, and a database link of 8 MB/s (the report's own reads ran at about 10 MB/s: 129 MB
 * in 12.7 s, 46 MB in 4.3 s). Master read every version body in one statement inside the publication transaction, which
 * its 5 s statement timeout cancelled on every retry. The extract now publishes and retracts the row only an old
 * version produced.
 */
export async function manyLargeVersionsPublish(databaseUrl: string) {
  const link = await throttledPostgres(databaseUrl, 8 * 1024 * 1024);
  try {
    await managedBrain(async ({ engine, ctx }) => {
      await engine.setConfig('auto_link', 'false');
      const filler = Array.from({ length: 32_000 }, (_, i) => `w${(i * 2654435761 % 4294967296).toString(16)}`).join(' ');
      await put(ctx, `${filler}\n\n## Timeline\n\n${KEPT}`);
      await disposePersistenceConsumer(engine);
      const [{ body }] = await engine.executeRaw<{ body: number }>('SELECT octet_length(compiled_truth)::int AS body FROM pages WHERE slug = $1', [SLUG]);
      expect(body).toBeGreaterThan(250_000);
      await guarded(engine, tx => tx.executeRaw(`INSERT INTO page_versions (page_id, compiled_truth, timeline)
        SELECT p.id, CASE WHEN i = 1 THEN $2 ELSE '' END || (SELECT string_agg(md5(i::text || '-' || j::text), ' ') FROM generate_series(1, 9000) j), ''
        FROM pages p, generate_series(1, 300) i WHERE p.slug = $1`, [SLUG, `## Timeline\n\n${REMOVED}\n\n`]));
      await storeRows(engine, [['2026-02-03', 'Joined Acme'], ['2026-04-05', 'Enriched note']]);
      const [{ n, bytes }] = await engine.executeRaw<{ n: number; bytes: number }>(`SELECT count(*)::int AS n, sum(octet_length(v.compiled_truth))::bigint AS bytes
        FROM page_versions v JOIN pages p ON p.id = v.page_id WHERE p.slug = $1`, [SLUG]);
      expect(n).toBeGreaterThanOrEqual(300);
      expect(Number(bytes)).toBeGreaterThan(80_000_000);
      await publishManagedPageTimeline(engine, SLUG, 'default');
      const extracts = () => engine.executeRaw<{ state: string; error_code: string | null; message: string | null }>(`SELECT state, error_code,
        left(error_message, 200) AS message FROM persistence_requests WHERE slug = $1 AND intent->>'kind' = 'managed_maintenance_timeline_extract'`, [SLUG]);
      let requests = await extracts();
      for (const deadline = performance.now() + 200_000; requests.some(row => !isTerminalWriteState(row.state as 'committed')) && performance.now() < deadline;) {
        await Bun.sleep(1_000);
        requests = await extracts();
      }
      expect(requests).toEqual([{ state: 'committed', error_code: null, message: null }]);
      expect(await summaries(engine)).toEqual(['Met Acme', 'Enriched note']);
    }, { databaseUrl: link.url });
  } finally { await link.close(); }
}
