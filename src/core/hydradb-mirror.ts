/**
 * Mirror the brain into its connected HydraDB database (hydradb.ts).
 *
 * What leaves the machine is exactly what gbrain already hands an embedding
 * provider: the page's fence-aware chunk projection (markdown-chunks.ts), so
 * private fact rows, held fence rows and private keys are gone, and
 * embed-skipped or quarantined pages project to nothing; secrets the scanner
 * finds are redacted on top. A private page or an empty projection is removed
 * from the cloud instead, as is every page soft-deleted since the last run.
 *
 * Pages walk the `(updated_at, slug, source_id)` keyset behind the delta commit-lag
 * horizon; the cursor advances after each batch lands, so an interrupted or
 * failed run resumes where it stopped. Bound: a page soft-deleted and then
 * purged (72h) while every run failed stays in the cloud until
 * `gbrain cloud disconnect --purge-cloud`.
 */

import type { BrainEngine } from './engine.ts';
import type { Page } from './types.ts';
import type { ProgressReporter } from './progress.ts';
import { horizonIso, toMicroIso } from './context/delta-cursor.ts';
import { prepareFenceAwareMarkdownChunks } from './markdown-chunks.ts';
import { isPrivatePage } from './search/private-visibility.ts';
import { isEmbedSkipped } from './embed-skip.ts';
import { redactFindings } from './secret-scan.ts';
import { HYDRADB_CONFIG, hasHydraKey, hydraDocId, hydraDocMetadata, resolveHydraConnection, type HydraConnection } from './hydradb.ts';
import { ingestHydra, deleteHydra } from './hydradb-transfer.ts';
import { pageKey } from './search/read-policy-sql.ts';
import { registerBackgroundWorkDrainer } from './background-work.ts';

const BATCH = 50;
/** HydraDB rejects the whole ingest request when one item's additional_metadata exceeds 1 KiB. */
const MAX_METADATA_BYTES = 1024;

export interface MirrorReport {
  upserted: number;
  removed: number;
  /** Pages whose identity is too long for HydraDB metadata; never mirrored. */
  skipped: number;
}

interface PageRef { source_id: string; slug: string }

/**
 * The text gbrain would embed for `page`, minus code-fence chunks that repeat
 * the prose, with every secret the scanner finds redacted: unlike an embedding
 * call, the cloud keeps the text (same rule as the Memorable relay).
 */
export async function hydraProjection(engine: BrainEngine, page: Page): Promise<string> {
  if (isPrivatePage(page) || isEmbedSkipped(page.frontmatter)) return '';
  const chunks = await prepareFenceAwareMarkdownChunks(engine, page.source_id, page.slug, page);
  const text = chunks.filter((c) => c.chunk_source !== 'fenced_code').map((c) => c.chunk_text).join('\n\n').trim();
  return redactFindings(text, { highEntropy: true }).text;
}

/**
 * Pages go up as markdown files: HydraDB chunks a file's text, while an
 * `app_knowledge` item of a type it has no connector parser for is chunked as
 * its serialized JSON. The title leads the body because files carry none.
 */
async function ingest(conn: HydraConnection, pages: Array<{ page: Page; text: string }>, signal?: AbortSignal): Promise<void> {
  if (!pages.length) return;
  const form = new FormData();
  form.set('type', 'knowledge');
  form.set('database', conn.database);
  form.set('upsert', 'true');
  for (const { page, text } of pages) {
    const title = redactFindings(page.title || page.slug, { highEntropy: true }).text;
    form.append('documents', new Blob([`# ${title}\n\n${text}\n`], { type: 'text/markdown' }), `${title.replace(/[\\/\x00-\x1f]/g, ' ').slice(0, 120)}.md`);
  }
  form.set('document_metadata', JSON.stringify(pages.map(({ page }) => ({
    id: hydraDocId(page.source_id, page.slug),
    additional_metadata: hydraDocMetadata(page.source_id, page.slug, page),
  }))));
  await ingestHydra(conn, form, pages.map(({ page }) => hydraDocId(page.source_id, page.slug)), signal);
}

async function remove(conn: HydraConnection, refs: PageRef[], signal?: AbortSignal): Promise<void> {
  if (!refs.length) return;
  await deleteHydra(conn, refs.map((r) => hydraDocId(r.source_id, r.slug)), signal);
}

/** Upload each page's projection, or remove the page from the cloud when it projects to nothing. */
async function sync(engine: BrainEngine, conn: HydraConnection, pages: Page[], report: MirrorReport, signal?: AbortSignal): Promise<void> {
  const upserts: Array<{ page: Page; text: string }> = [];
  const removals: PageRef[] = [];
  for (const page of pages) {
    if (Buffer.byteLength(JSON.stringify(hydraDocMetadata(page.source_id, page.slug, page))) > MAX_METADATA_BYTES) {
      report.skipped++;
      removals.push(page);
      continue;
    }
    const text = await hydraProjection(engine, page);
    if (text) upserts.push({ page, text });
    else removals.push(page);
  }
  await ingest(conn, upserts, signal);
  await remove(conn, removals, signal);
  report.upserted += upserts.length;
  report.removed += removals.length;
}

interface MirrorCursor { updatedAt: string; slug: string; sourceId: string }
const locks = new WeakMap<BrainEngine, Promise<unknown>>();
/** Serialize snapshots through indexed completion across engines and PostgreSQL processes. */
export function withCloudLock<T>(engine: BrainEngine, work: (signal?: AbortSignal) => Promise<T>): Promise<T> {
  const run = (locks.get(engine) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    if (engine.kind !== 'postgres') return work(); // PGLite owns its database exclusively.
    return engine.withReservedConnection(async conn => {
      // A transaction pins the reserved backend even behind transaction-mode PgBouncer.
      // Keep mirror reads/cursor writes outside this transaction so completed batches persist.
      await conn.executeRaw('BEGIN');
      const controller = new AbortController();
      let heartbeat: Promise<unknown> = Promise.resolve();
      let timer: ReturnType<typeof setInterval> | undefined;
      try {
        await conn.executeRaw("SET LOCAL idle_in_transaction_session_timeout = '5min'");
        await conn.executeRaw("SET LOCAL lock_timeout = '120s'");
        await conn.executeRaw("SELECT pg_advisory_xact_lock(hashtextextended('gbrain:hydradb:mirror', 0))");
        // Long backfills must keep the pinned transaction alive. Losing it cancels transfers.
        timer = setInterval(() => {
          heartbeat = heartbeat.then(() => conn.executeRaw('SELECT 1')).catch(error => controller.abort(error));
        }, 30_000);
        timer.unref?.();
        const result = await work(controller.signal);
        controller.signal.throwIfAborted();
        return result;
      } finally {
        clearInterval(timer);
        await heartbeat;
        await conn.executeRaw('ROLLBACK'); // releases the lock on success and failure
      }
    });
  });
  locks.set(engine, run);
  void run.finally(() => { if (locks.get(engine) === run) locks.delete(engine); }).catch(() => undefined);
  return run;
}

export function mirrorBrain(engine: BrainEngine, conn: HydraConnection,
  opts: { full?: boolean; progress?: ProgressReporter; signal?: AbortSignal } = {}): Promise<MirrorReport> {
  return withCloudLock(engine, signal => mirror(engine, conn, { ...opts, signal: opts.signal && signal ? AbortSignal.any([opts.signal, signal]) : opts.signal ?? signal }));
}

async function mirror(engine: BrainEngine, conn: HydraConnection,
  opts: { full?: boolean; progress?: ProgressReporter; signal?: AbortSignal } = {}): Promise<MirrorReport> {
  const report: MirrorReport = { upserted: 0, removed: 0, skipped: 0 };
  const horizon = opts.full ? toMicroIso(new Date().toISOString()) : horizonIso();

  await reconcileSources(engine, conn, report, opts.signal);

  const deletedSince = await engine.getConfig(HYDRADB_CONFIG.deletedSince);
  if (deletedSince) {
    const gone = await engine.executeRaw<PageRef>(
      `SELECT source_id, slug FROM pages WHERE deleted_at > $1::text::timestamptz AND deleted_at <= $2::text::timestamptz`,
      [deletedSince, horizon]);
    for (let i = 0; i < gone.length; i += BATCH) await remove(conn, gone.slice(i, i + BATCH), opts.signal);
    report.removed += gone.length;
  }
  await engine.setConfig(HYDRADB_CONFIG.deletedSince, horizon);

  const saved = opts.full ? null : await engine.getConfig(HYDRADB_CONFIG.pagesCursor);
  const parsed = saved ? JSON.parse(saved) as MirrorCursor : null;
  // Legacy cursors omitted source identity; replay once instead of skipping a cross-source tie.
  let cursor = parsed?.sourceId ? parsed : null;
  opts.progress?.start('cloud.mirror');
  for (;;) {
    opts.signal?.throwIfAborted();
    const refs = await engine.executeRaw<PageRef & { at: string; archived: boolean }>(
      `SELECT p.source_id, p.slug, s.archived,
        to_char(p.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
       FROM pages p JOIN sources s ON s.id = p.source_id
       WHERE p.deleted_at IS NULL AND p.updated_at <= $1::text::timestamptz
         ${cursor ? 'AND (p.updated_at, p.slug, p.source_id) > ($2::text::timestamptz, $3::text, $4::text)' : ''}
       ORDER BY p.updated_at, p.slug, p.source_id LIMIT ${BATCH}`,
      cursor ? [horizon, cursor.updatedAt, cursor.slug, cursor.sourceId] : [horizon]);
    if (!refs.length) break;
    const pages: Page[] = [];
    const gone: PageRef[] = [];
    for (const ref of refs) {
      const page = ref.archived ? null : await engine.getPage(ref.slug, { sourceId: ref.source_id });
      if (page) pages.push(page); else gone.push(ref);
    }
    await sync(engine, conn, pages, report, opts.signal);
    await remove(conn, gone, opts.signal);
    report.removed += gone.length;
    const last = refs[refs.length - 1]!;
    cursor = { updatedAt: last.at, slug: last.slug, sourceId: last.source_id };
    await engine.setConfig(HYDRADB_CONFIG.pagesCursor, JSON.stringify(cursor));
    opts.progress?.tick(refs.length);
    if (refs.length < BATCH) break;
  }
  opts.progress?.finish(`${report.upserted} mirrored, ${report.removed} removed`);
  await engine.setConfig(HYDRADB_CONFIG.lastPushAt, new Date().toISOString());
  return report;
}

/** Source visibility changes do not touch pages.updated_at; reconcile them independently. */
async function reconcileSources(engine: BrainEngine, conn: HydraConnection, report: MirrorReport, signal?: AbortSignal): Promise<void> {
  const sources = await engine.executeRaw<{ id: string; archived: boolean }>('SELECT id, archived FROM sources');
  const saved = await engine.getConfig(HYDRADB_CONFIG.sourceStates);
  const previous: Record<string, boolean> = saved ? JSON.parse(saved) : {};
  for (const source of sources) {
    if (source.archived ? previous[source.id] === true : previous[source.id] !== true) continue;
    let slug: string | null = null;
    for (;;) {
      signal?.throwIfAborted();
      const refs: PageRef[] = await engine.executeRaw<PageRef>(
        `SELECT source_id, slug FROM pages WHERE source_id = $1 AND deleted_at IS NULL
         ${slug === null ? '' : 'AND slug > $2'} ORDER BY slug LIMIT ${BATCH}`,
        slug === null ? [source.id] : [source.id, slug]);
      if (!refs.length) break;
      if (source.archived) { await remove(conn, refs, signal); report.removed += refs.length; }
      else {
        const pages = await Promise.all(refs.map(ref => engine.getPage(ref.slug, { sourceId: ref.source_id })));
        await sync(engine, conn, pages.filter((p): p is Page => p !== null), report, signal);
      }
      slug = refs[refs.length - 1]!.slug;
      if (refs.length < BATCH) break;
    }
  }
  // Failed removals/restores leave the previous snapshot intact for retry.
  await engine.setConfig(HYDRADB_CONFIG.sourceStates, JSON.stringify(Object.fromEntries(sources.map(s => [s.id, s.archived]))));
}

/**
 * Push on write: the persistence consumer reports each committed page write
 * (service.ts onSettled); writes coalesce for PUSH_DEBOUNCE_MS and the pages
 * go up as they are now (deleted ones are removed). Only a connected brain
 * pushes. A failed push is left to the cursor mirror and the cycle phase,
 * which resend everything after their cursor.
 */
const PUSH_DEBOUNCE_MS = 300;
const queued = new Map<BrainEngine, { refs: Map<string, PageRef>; timer: ReturnType<typeof setTimeout> }>();
const pushing = new Set<Promise<void>>();
const starting = new Set<Promise<void>>();

export function scheduleCloudPush(engine: BrainEngine, ref: PageRef): void {
  const start = hasHydraKey().then((has) => { if (has) enqueue(engine, ref); }).catch(() => undefined);
  starting.add(start);
  void start.finally(() => starting.delete(start));
}

function enqueue(engine: BrainEngine, ref: PageRef): void {
  const entry = queued.get(engine) ?? { refs: new Map<string, PageRef>(), timer: setTimeout(() => flushCloudPush(engine), PUSH_DEBOUNCE_MS) };
  entry.timer.unref?.();
  entry.refs.set(pageKey(ref.source_id, ref.slug), { source_id: ref.source_id, slug: ref.slug });
  queued.set(engine, entry);
}

function flushCloudPush(engine: BrainEngine): void {
  const entry = queued.get(engine);
  if (!entry) return;
  queued.delete(engine);
  clearTimeout(entry.timer);
  const run = withCloudLock(engine, async signal => {
    const conn = await resolveHydraConnection(engine);
    if (!conn) return;
    const pages: Page[] = [];
    const gone: PageRef[] = [];
    for (const ref of entry.refs.values()) {
      const [source] = await engine.executeRaw<{ archived: boolean }>('SELECT archived FROM sources WHERE id = $1', [ref.source_id]);
      const page = source && !source.archived ? await engine.getPage(ref.slug, { sourceId: ref.source_id }) : null;
      if (page) pages.push(page);
      else gone.push(ref);
    }
    await sync(engine, conn, pages, { upserted: 0, removed: 0, skipped: 0 }, signal);
    await remove(conn, gone, signal);
  }).catch(() => undefined);
  pushing.add(run);
  void run.finally(() => pushing.delete(run));
}

registerBackgroundWorkDrainer({
  name: 'cloud-push',
  order: 6,
  async drain(timeoutMs, mode) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const drain = async () => {
      await Promise.allSettled([...starting]);
      for (const engine of [...queued.keys()]) {
        if (mode === 'exit') flushCloudPush(engine);
        else { clearTimeout(queued.get(engine)!.timer); queued.delete(engine); }
      }
      await Promise.allSettled([...pushing]);
    };
    await Promise.race([drain(), new Promise((r) => { timer = setTimeout(r, timeoutMs); })]);
    clearTimeout(timer);
    return { unfinished: pushing.size + starting.size };
  },
});
