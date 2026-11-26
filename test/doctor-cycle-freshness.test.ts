/**
 * v0.38 — doctor checkCycleFreshness unit test.
 *
 * Mirrors checkSyncFreshness shape: returns Check with status mapping to
 * per-source last_full_cycle_at from sources.config JSONB. Reads what
 * autopilot's per-source dispatch gate writes.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { checkCycleFreshness } from '../src/commands/doctor.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { listSourceChangedPages, sourceCycleWindowStamp, sourceWindow } from '../src/core/cycle/source-window.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

const NOW = Date.parse('2026-05-22T12:00:00.000Z');
const agoH = (h: number) => new Date(NOW - h * 3600_000).toISOString();

/**
 * A source row. Never-cycled sources get one page created 30 days before NOW
 * (content that should have been cycled) unless `pageAgeH` says otherwise
 * (`null` = no pages: an empty source, which E2 reports as information).
 */
async function seed(id: string, lastFullCycleAt?: string, opts: { local_path?: string | null; syncEnabled?: boolean; pageAgeH?: number | null } = {}): Promise<void> {
  const config = JSON.stringify({ last_full_cycle_at: lastFullCycleAt, syncEnabled: opts.syncEnabled });
  const localPath = opts.local_path === undefined ? `/tmp/${id}` : opts.local_path;
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config, archived, created_at)
     VALUES ($1, $2, $3, $4::text::jsonb, false, NOW())
     ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path, config = EXCLUDED.config`,
    [id, id, localPath, config],
  );
  const pageAgeH = opts.pageAgeH === undefined ? (lastFullCycleAt === undefined ? 24 * 30 : null) : opts.pageAgeH;
  if (pageAgeH !== null) {
    await engine.executeRaw(
      `INSERT INTO pages (source_id, slug, type, title, created_at) VALUES ($1, $2, 'note', $2, $3::timestamptz)`,
      [id, `${id}-page`, agoH(pageAgeH)],
    );
  }
}

describe('doctor checkCycleFreshness', () => {
  test('empty (no federated sources) returns ok', async () => {
    // resetPgliteState reseeds the default source with no local_path
    await engine.executeRaw(`UPDATE sources SET local_path = NULL WHERE id = 'default'`);
    const result = await checkCycleFreshness(engine, { nowMs: NOW });
    expect(result.status).toBe('ok');
    expect(result.message).toMatch(/No federated sources/);
  });

  test('source with last_full_cycle_at 2h ago returns ok (under 6h warn)', async () => {
    await seed('fresh', agoH(2));
    // default source also has no last_full_cycle_at — so we'd get a fail
    // unless default lacks local_path. resetPgliteState seeds default with
    // no local_path, so it's filtered. Confirm.
    await engine.executeRaw(`UPDATE sources SET local_path = NULL WHERE id = 'default'`);
    const result = await checkCycleFreshness(engine, { nowMs: NOW });
    expect(result.status).toBe('ok');
  });

  test('source with last_full_cycle_at 10h ago returns warn (>6h, <24h)', async () => {
    await engine.executeRaw(`UPDATE sources SET local_path = NULL WHERE id = 'default'`);
    await seed('warned', agoH(10));
    const result = await checkCycleFreshness(engine, { nowMs: NOW });
    expect(result.status).toBe('warn');
    expect(result.message).toMatch(/warned/);
    expect(result.message).toMatch(/10h ago/);
  });

  test('source with last_full_cycle_at 48h ago returns fail (>24h)', async () => {
    await engine.executeRaw(`UPDATE sources SET local_path = NULL WHERE id = 'default'`);
    await seed('stale', agoH(48));
    const result = await checkCycleFreshness(engine, { nowMs: NOW });
    expect(result.status).toBe('fail');
    expect(result.message).toMatch(/stale/);
    expect(result.message).toMatch(/gbrain dream --source/);
  });

  test('source with NO last_full_cycle_at (never cycled) returns warn, not fail (#2540)', async () => {
    // #2540: never-cycled used to FAIL, which turned doctor permanently red
    // on any install that doesn't cycle every local_path source (e.g. one
    // nightly `dream --dir <vault>` plus other federated sources) — and on
    // any source added minutes ago. It surfaces as a warning; only a source
    // that HAS cycled and then went stale escalates to fail.
    await engine.executeRaw(`UPDATE sources SET local_path = NULL WHERE id = 'default'`);
    await seed('virgin');
    const result = await checkCycleFreshness(engine, { nowMs: NOW });
    expect(result.status).toBe('warn');
    expect(result.message).toMatch(/never completed a full cycle/);
    expect(result.message).toMatch(/gbrain dream --source/);
  });

  test('E2: a never-cycled source with no pages is information, not a warning', async () => {
    await engine.executeRaw(`UPDATE sources SET local_path = NULL WHERE id = 'default'`);
    await seed('empty-vault', undefined, { pageAgeH: null });
    const result = await checkCycleFreshness(engine, { nowMs: NOW });
    expect(result.status).toBe('ok');
    expect(result.severity).toBe('info');
    expect(result.readiness_state).toBe('not_applicable');
    expect(result.message).toMatch(/empty-vault/);
  });

  test('E2: a never-cycled source whose pages are all under 24h old is information', async () => {
    await engine.executeRaw(`UPDATE sources SET local_path = NULL WHERE id = 'default'`);
    await seed('new-vault', undefined, { pageAgeH: 2 });
    const result = await checkCycleFreshness(engine, { nowMs: NOW });
    expect(result.status).toBe('ok');
    expect(result.severity).toBe('info');
  });

  test('E2: a never-cycled source with old pages still warns, with a dream fix that asks first', async () => {
    await engine.executeRaw(`UPDATE sources SET local_path = NULL WHERE id = 'default'`);
    await seed('old-vault');
    configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'test' } });
    try {
      const result = await checkCycleFreshness(engine, { nowMs: NOW });
      expect(result.status).toBe('warn');
      expect(result.fix).toMatchObject({ argv: ['gbrain', 'dream', '--source', 'old-vault'], consent: ['paid'], actor: 'agent' });
    } finally {
      resetGateway();
    }
  });

  test('reporter case (#2540): one cycled vault + never-cycled siblings is warn, not permanent fail', async () => {
    await engine.executeRaw(`UPDATE sources SET local_path = NULL WHERE id = 'default'`);
    await seed('nightly-vault', agoH(2)); // the one vault dreamt via --dir
    await seed('federated-a');            // never cycled
    await seed('federated-b');            // never cycled
    const result = await checkCycleFreshness(engine, { nowMs: NOW });
    expect(result.status).toBe('warn');
    expect(result.message).toMatch(/federated-a/);
    expect(result.message).toMatch(/federated-b/);
    expect(result.message).not.toMatch(/nightly-vault/);
  });

  test('a previously-cycled source gone stale still fails even next to never-cycled sources', async () => {
    await engine.executeRaw(`UPDATE sources SET local_path = NULL WHERE id = 'default'`);
    await seed('stale', agoH(72));  // real regression signal
    await seed('virgin');           // never cycled — warn-only
    const result = await checkCycleFreshness(engine, { nowMs: NOW });
    expect(result.status).toBe('fail');
  });

  test('mixed sources: highest severity wins (fail > warn > ok)', async () => {
    await engine.executeRaw(`UPDATE sources SET local_path = NULL WHERE id = 'default'`);
    await seed('fresh', agoH(1));     // ok
    await seed('warned', agoH(12));   // warn
    await seed('stale', agoH(72));    // fail
    const result = await checkCycleFreshness(engine, { nowMs: NOW });
    expect(result.status).toBe('fail');
  });

  test('future last_full_cycle_at returns warn (clock skew)', async () => {
    await engine.executeRaw(`UPDATE sources SET local_path = NULL WHERE id = 'default'`);
    const future = new Date(NOW + 3600_000).toISOString();
    await seed('clock-skewed', future);
    const result = await checkCycleFreshness(engine, { nowMs: NOW });
    expect(result.status).toBe('warn');
    expect(result.message).toMatch(/future last_full_cycle_at/);
  });

  test('unparseable last_full_cycle_at returns warn', async () => {
    await engine.executeRaw(`UPDATE sources SET local_path = NULL WHERE id = 'default'`);
    await seed('garbled', 'not-an-iso-date');
    const result = await checkCycleFreshness(engine, { nowMs: NOW });
    expect(result.status).toBe('warn');
    expect(result.message).toMatch(/unparseable/);
  });

  test('local_path NULL sources are filtered (codex P1-4 parity)', async () => {
    await engine.executeRaw(`UPDATE sources SET local_path = NULL WHERE id = 'default'`);
    await seed('db-only', undefined, { local_path: null });
    // No federated sources to check; default is unsynced but filtered.
    const result = await checkCycleFreshness(engine, { nowMs: NOW });
    expect(result.status).toBe('ok');
    expect(result.message).toMatch(/No federated sources/);
  });

  test('GST-3337: a sync-disabled source reads sync off, never stale or failing, and is never the fix target', async () => {
    await seed('disabled-example', agoH(72), { syncEnabled: false });
    await seed('enabled-example', agoH(1), { syncEnabled: true });
    const result = await checkCycleFreshness(engine, { nowMs: NOW });
    expect(result.status).toBe('ok');
    expect(result.message).toBe("All 1 federated source(s) cycled recently. Sync off (not checked; only an explicit gbrain sync --source <id> syncs it): 'disabled-example'.");
    expect(result.fix).toBeUndefined();
  });

  test('GST-3337: a stale enabled source is still the fix target beside a sync-disabled one', async () => {
    await seed('disabled-example', undefined, { syncEnabled: false });
    await seed('stale-example', agoH(72));
    const result = await checkCycleFreshness(engine, { nowMs: NOW });
    expect(result.status).toBe('fail');
    expect(result.message).toContain("'stale-example' last cycled 72h ago");
    expect(result.message).toContain("Sync off (not checked; only an explicit gbrain sync --source <id> syncs it): 'disabled-example'.");
    expect(result.fix?.argv).toEqual(expect.arrayContaining(['gbrain', 'dream', '--source', 'stale-example']));
  });

  // #8577: a bounded window stamps the cycle timestamps even when it stopped at its page limit.
  describe('a source walked in bounded windows', () => {
    /** Seeds `pages` live pages, then stamps the cursor the real window listing leaves after one window of `limit`. */
    async function walkOneWindow(id: string, pages: number, limit: number, config: Record<string, unknown> = {}) {
      await engine.executeRaw(`INSERT INTO sources (id, name, local_path, config) VALUES ($1, $1, $2, '{}'::jsonb)`, [id, `/tmp/${id}`]);
      for (let i = 0; i < pages; i++) {
        await engine.executeRaw(`INSERT INTO pages (source_id, slug, type, title, created_at) VALUES ($1, $2, 'note', $2, $3::timestamptz)`,
          [id, `${id}/page-${String(i).padStart(2, '0')}`, agoH(24 * 30)]);
      }
      return stampWindow(id, null, limit, config);
    }
    async function stampWindow(id: string, since: string | null, limit: number, config: Record<string, unknown> = {}) {
      const saved = sourceWindow.pageLimit;
      sourceWindow.pageLimit = limit;
      try {
        const window = await listSourceChangedPages(engine, id, since);
        const stamp = sourceCycleWindowStamp(['extract', 'extract_facts', 'recompute_emotional_weight'].map(phase => ({ phase, status: 'ok' })), window);
        await engine.executeRaw('UPDATE sources SET config = config || $2::text::jsonb WHERE id = $1',
          [id, JSON.stringify({ ...config, ...stamp, last_full_cycle_at: agoH(1), last_source_cycle_at: agoH(1) })]);
        return stamp;
      } finally { sourceWindow.pageLimit = saved; }
    }

    test('a recent window that stopped at its limit notes the pages left after the cursor, without a warning or a fix', async () => {
      await engine.executeRaw(`UPDATE sources SET local_path = NULL WHERE id = 'default'`);
      const stamp = await walkOneWindow('walk-example', 5, 2);
      expect(stamp.last_source_cycle_window_slug).toBe('walk-example/page-01');
      const result = await checkCycleFreshness(engine, { nowMs: NOW });
      expect(result.status).toBe('ok');
      expect(result.message).toContain("Source 'walk-example' is partway through a bounded page walk: 3 live page(s) after its cursor");
      expect(result.fix).toBeUndefined();
      expect((result as { details?: unknown }).details).toEqual({ source_windows: [{ source_id: 'walk-example',
        cursor_at: stamp.last_source_cycle_window_at, cursor_slug: 'walk-example/page-01', remaining_pages: 3 }] });

      // Deleted pages and other sources' pages are not left to walk.
      await engine.executeRaw("UPDATE pages SET deleted_at = now() WHERE slug IN ('walk-example/page-00', 'walk-example/page-04')");
      await seed('other-example', agoH(1), { pageAgeH: 24 * 30 });
      expect((await checkCycleFreshness(engine, { nowMs: NOW })).message).toContain('2 live page(s) after its cursor');

      // The next window lists the rest and stamps an empty slug: the walk is done.
      await stampWindow('walk-example', stamp.last_source_cycle_window_at!, 2);
      const done = await checkCycleFreshness(engine, { nowMs: NOW });
      expect(done.status).toBe('ok');
      expect((done as { details?: unknown }).details).toBeUndefined();
    });

    test('a sync-off source notes its unfinished walk without a warning or a fix', async () => {
      await engine.executeRaw(`UPDATE sources SET local_path = NULL WHERE id = 'default'`);
      await seed('enabled-example', agoH(1), { syncEnabled: true });
      await walkOneWindow('connector-example', 3, 1, { syncEnabled: false });
      const result = await checkCycleFreshness(engine, { nowMs: NOW });
      expect(result.status).toBe('ok');
      expect(result.fix).toBeUndefined();
      expect(result.message).toContain("Sync off (not checked; only an explicit gbrain sync --source <id> syncs it): 'connector-example'.");
      expect(result.message).toContain("Source 'connector-example' is partway through a bounded page walk: 2 live page(s) after its cursor");
      expect((result as { details?: { source_windows: Array<{ remaining_pages: number }> } }).details?.source_windows[0]?.remaining_pages).toBe(2);
    });

    test('a cursor in another shape than the window listing writes is ignored, so a stale source still fails', async () => {
      await engine.executeRaw(`UPDATE sources SET local_path = NULL WHERE id = 'default'`);
      await seed('stale-example', agoH(72));
      await walkOneWindow('corrupt-example', 3, 1, { syncEnabled: false });
      await engine.executeRaw(`UPDATE sources SET config = config || '{"last_source_cycle_window_at":"not a time"}'::jsonb WHERE id = 'corrupt-example'`);
      const result = await checkCycleFreshness(engine, { nowMs: NOW });
      expect(result.status).toBe('fail');
      expect(result.message).toContain("'stale-example' last cycled 72h ago");
      expect((result as { details?: unknown }).details).toBeUndefined();
    });
  });
});
