/**
 * Wave B PR 2 switch-on (spec 1.1 activation gate, 13 PR 2): `pages.segmented_storage` follows
 * SEGMENTED_STORAGE_DEFAULT when unset and is gated by the writer versions recorded on committed persistence requests.
 *
 * 1. Protects: with no configuration a page over 1 MiB is stored segmented and `pages.max_bytes` is the engine
 *    ceiling; a writer older than SEGMENTED_WRITER_FLOOR (or unstamped) seen in the last seven days keeps writes
 *    inline, even with an explicit `on`, and doctor `segmented_storage` names it with an upgrade fix; once that
 *    observation is gone the next write promotes; an explicit `off` keeps pages inline and reports it as a choice;
 *    (a stored segmented page over 32 MiB exporting while the switch is off is in segmented-real-size.slow.test.ts). Every write the gate sees must carry the
 *    segment-reader mark (v254): a release at exactly the floor version without it, an older binary's import or sync
 *    run (ingest_log), its resident heartbeat and its uncommitted requests all block; this build's do not. An
 *    unreadable gate blocks, an unparsable stamp blocks, the 7-day window ends between day 6 and day 8, and the gate is
 *    read once per TTL (work counter) while doctor reads through. A failed read of the switch or `pages.max_bytes` keeps
 *    it off (never "unset", which is on). Doctor reports a hold left only by this host's pre-upgrade writes as
 *    information once this build has made the same kind of write after them; an older gbrain still writing on this host
 *    (a cron import, an npx sync, an older managed admitter) keeps the upgrade warning. (The floor's derivation: segmented-writer-floor.test.ts.)
 * 2. Fails when: the default stays off, the gate ignores old or unstamped writers, an explicit `on` overrides the
 *    gate, a cleared gate keeps writes inline, export sizes stored segmented pages by the write limit, a writer without
 *    the mark passes on its version, a write path of this build stops marking, or the gate's error, window, parse or
 *    cache handling changes.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { PAGE_MAX_BYTES } from '../../src/core/page-size-policy.ts';
import { _resetSegmentedWriterGateForTests, readPageBodyPolicy, SEGMENTED_WRITER_GATE_TTL_MS, SEGMENTED_WRITER_WINDOW_DAYS, segmentedPageCeiling, segmentedWriterGateWork } from '../../src/core/page-body/limits.ts';
import { declarePersistenceProtocol } from '../../src/core/persistence/protocol.ts';
import { compareWriterVersions, segmentedGateWriters, UNSTAMPED_WRITER } from '../../src/core/persistence/writer-versions.ts';
import { SEGMENTED_WRITER_FLOOR } from '../../src/core/page-body/writer-floor.ts';
import { VERSION } from '../../src/version.ts';
import { localHostId } from '../../src/core/persistence/identity.ts';
import { segmentedStorageCheck } from '../../src/commands/doctor/checks/segmented-storage.ts';
import { startConsumerHeartbeat } from '../../src/core/persistence/consumer-heartbeat.ts';
import { conversationPage } from '../helpers/conversation-page.ts';
import { editRequest, freshBrainFactory, requestFixture } from '../helpers/persistence-request-fixture.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';

const content = conversationPage(2 * 1024 * 1024, { seed: 61 });

async function storage(engine: BrainEngine, slug: string): Promise<string | undefined> {
  return (await engine.executeRaw<{ body_storage: string }>('SELECT body_storage FROM pages WHERE slug=$1', [slug]))[0]?.body_storage;
}

for (const kind of testBackends()) {
  describe(`segmented storage switch: ${kind}`, () => {
    let factory: Awaited<ReturnType<typeof freshBrainFactory>>;
    let engine: BrainEngine;
    let home: string;
    beforeAll(async () => {
      home = mkdtempSync(join(tmpdir(), 'gbrain-segmented-switch-'));
      factory = await freshBrainFactory(kind, process.env.DATABASE_URL);
    }, 120_000);
    afterAll(async () => {
      await factory?.dispose();
      rmSync(home, { recursive: true, force: true });
    });
    beforeEach(async () => {
      engine = await factory.fresh();
      _resetSegmentedWriterGateForTests();
    });
    const inHome = <T>(fn: () => Promise<T>) => withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, fn);

    test('default on: a page over 1 MiB is stored segmented and pages.max_bytes is the engine ceiling', async () => {
      expect(await engine.getConfig('pages.segmented_storage')).toBeNull();
      expect(await readPageBodyPolicy(engine)).toMatchObject({ segmented: true, maxBytes: segmentedPageCeiling(engine.kind) });
      expect((await importFromContent(engine, 'notes/default-on', content, { noEmbed: true })).status).toBe('imported');
      expect(await storage(engine, 'notes/default-on')).toBe('segmented');
      expect(await segmentedStorageCheck(engine)).toMatchObject({ status: 'ok', details: { configured: 'unset', effective: 'on', blockers: [] } });
    }, 120_000);

    test('a recent writer below the floor keeps writes inline, even with an explicit on; once it is gone the next write promotes', async () => inHome(async () => {
      const requests = await requestFixture(engine);
      const published = await requests.publish(await requests.admit('page'));
      await editRequest(engine, published.id, "admitter_version='0.60.200.0',consumer_version='0.60.200.0'");
      for (const setting of [null, 'on']) {
        if (setting) await engine.setConfig('pages.segmented_storage', setting);
        _resetSegmentedWriterGateForTests();
        expect(await readPageBodyPolicy(engine)).toMatchObject({ segmented: false, maxBytes: PAGE_MAX_BYTES });
        const slug = `notes/held-${setting ?? 'default'}`;
        expect((await importFromContent(engine, slug, content, { noEmbed: true })).status).toBe('imported');
        expect(await storage(engine, slug)).toBe('inline');
      }
      const check = await segmentedStorageCheck(engine);
      expect(check).toMatchObject({ status: 'warn', details: { configured: 'on', effective: 'off' }, fix: { argv: ['gbrain', 'upgrade'], actor: 'host_admin' } });
      expect((check.details!.blockers as Array<{ host_id: string; version: string }>).map(row => [row.host_id, row.version]))
        .toContainEqual([localHostId(), '0.60.200.0']);
      expect(check.message).toContain('0.60.200.0');

      await editRequest(engine, published.id, 'admitter_version=NULL,consumer_version=NULL');
      _resetSegmentedWriterGateForTests();
      expect((await readPageBodyPolicy(engine)).segmented).toBe(false);

      await engine.transaction(async tx => {
        await declarePersistenceProtocol(tx);
        await tx.executeRaw('DELETE FROM persistence_effects WHERE request_id=$1::uuid', [published.id]);
        await tx.executeRaw('DELETE FROM persistence_requests WHERE id=$1::uuid', [published.id]);
      });
      _resetSegmentedWriterGateForTests();
      expect((await readPageBodyPolicy(engine)).segmented).toBe(true);
      expect((await importFromContent(engine, 'notes/held-on', `${content}\n\nOne more turn.\n`, { noEmbed: true })).status).toBe('imported');
      expect(await storage(engine, 'notes/held-on')).toBe('segmented');
      expect(await segmentedStorageCheck(engine)).toMatchObject({ status: 'ok', details: { effective: 'on' } });
    }), 120_000);

    /** The gate as a write reads it, after the per-engine cache is dropped. */
    const segmentedNow = async (e: BrainEngine = engine) => { _resetSegmentedWriterGateForTests(); return (await readPageBodyPolicy(e)).segmented; };
    const blockersNow = async () => (await segmentedStorageCheck(engine)).details!.blockers as Array<{ role: string; principal: string; version: string; segment_reader: boolean }>;
    /** What a binary older than v254 leaves on a request it admitted and published: its version stamp, and no segment-reader mark. */
    const asOlderBinary = (id: string, version: string | null) =>
      editRequest(engine, id, 'admitter_version=$2,consumer_version=$2,admitter_segment_reader=NULL,consumer_segment_reader=NULL', [version]);

    test('B6: a writer at exactly the floor passes only with the segment-reader mark; the same version from a release without segment readers blocks', async () => inHome(async () => {
      await engine.setConfig('pages.segmented_storage', 'on');
      const requests = await requestFixture(engine);
      const published = await requests.publish(await requests.admit('page'));
      await editRequest(engine, published.id, 'admitter_version=$2,consumer_version=$2', [SEGMENTED_WRITER_FLOOR]);
      expect(await segmentedNow()).toBe(true);
      await asOlderBinary(published.id, SEGMENTED_WRITER_FLOOR);
      expect(await segmentedNow()).toBe(false);
      expect((await blockersNow()).map(b => [b.role, b.version, b.segment_reader]).sort())
        .toEqual([['admitter', SEGMENTED_WRITER_FLOOR, false], ['consumer', SEGMENTED_WRITER_FLOOR, false]]);
      expect((await importFromContent(engine, 'notes/floor', content, { noEmbed: true })).status).toBe('imported');
      expect(await storage(engine, 'notes/floor')).toBe('inline');
    }), 120_000);

    test('B3: an import or sync run an older binary logged (an unmarked ingest_log row) blocks for 7 days; this build\'s runs do not', async () => {
      await engine.setConfig('pages.segmented_storage', 'on');
      await engine.logIngest({ source_type: 'import', source_ref: 'this-build', pages_updated: [], summary: 'this build' });
      expect(await segmentedNow()).toBe(true);
      // The statement every older binary's logIngest runs.
      await engine.executeRaw(`INSERT INTO ingest_log (source_id, source_type, source_ref, pages_updated, summary) VALUES ('default', 'sync', 'older-binary', '[]'::jsonb, 'older binary run')`);
      expect(await segmentedNow()).toBe(false);
      expect(await blockersNow()).toEqual([expect.objectContaining({ role: 'importer', principal: 'ingest:sync', version: UNSTAMPED_WRITER, segment_reader: false })]);
      expect((await importFromContent(engine, 'notes/after-old-sync', content, { noEmbed: true })).status).toBe('imported');
      expect(await storage(engine, 'notes/after-old-sync')).toBe('inline');
      await engine.executeRaw(`UPDATE ingest_log SET created_at = now() - interval '8 days' WHERE source_ref = 'older-binary'`);
      expect(await segmentedNow()).toBe(true);
    }, 120_000);

    test('B3: a resident process of an older binary (an unmarked consumer heartbeat) blocks while its row is recent', async () => {
      await engine.setConfig('pages.segmented_storage', 'on');
      // The heartbeat an older serve writes: no segment_reader column.
      await engine.executeRaw(`INSERT INTO persistence_consumers (host_id, pid, nonce, kind, mode, host_json_path, persistence_home, version)
        VALUES ($1::uuid, 4242, 'older-nonce', 'serve', 'full', '/tmp/host.json', '/tmp', '0.60.262.0')`, [randomUUID()]);
      expect(await segmentedNow()).toBe(false);
      expect(await blockersNow()).toEqual([expect.objectContaining({ role: 'resident', principal: 'process:serve', version: '0.60.262.0', segment_reader: false })]);
      await engine.executeRaw(`UPDATE persistence_consumers SET renewed_at = now() - interval '8 days' WHERE nonce = 'older-nonce'`);
      expect(await segmentedNow()).toBe(true);
      if (kind !== 'postgres') return;
      // This build's heartbeat carries the mark (PGLite admits one process and writes no heartbeat).
      const heartbeat = startConsumerHeartbeat(engine, randomUUID(), { kind: 'serve', mode: 'full', everyMs: 3_600_000,
        report: () => ({ restart_required: false, root_barrier_age_ms: null }), paths: { host_json_path: '/tmp/host.json', persistence_home: '/tmp', minted_under: null } });
      try {
        await heartbeat.renew();
        expect(Number((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM persistence_consumers WHERE segment_reader'))[0]!.n)).toBe(1);
        expect(await segmentedNow()).toBe(true);
      } finally { await heartbeat.stop(); }
    }, 120_000);

    test('B3: marked import runs and resident heartbeats are judged by the floor; unmarked ones block at any version', async () => {
      await engine.setConfig('pages.segmented_storage', 'on');
      const below = '0.60.200.0';
      const importRun = (ref: string, version: string, marked: boolean | null) => engine.executeRaw(`INSERT INTO ingest_log (source_id, source_type, source_ref, pages_updated, summary, writer_version, writer_host_id, writer_segment_reader)
        VALUES ('default', 'sync', $1, '[]'::jsonb, 'run', $2, $3::uuid, $4)`, [ref, version, randomUUID(), marked]);
      const heartbeat = (nonce: string, version: string, marked: boolean | null) => engine.executeRaw(`INSERT INTO persistence_consumers (host_id, pid, nonce, kind, mode, host_json_path, persistence_home, version, segment_reader)
        VALUES ($1::uuid, 4242, $2, 'serve', 'full', '/tmp/host.json', '/tmp', $3, $4)`, [randomUUID(), nonce, version, marked]);
      const seen = async (floor = SEGMENTED_WRITER_FLOOR) => (await segmentedGateWriters(engine, SEGMENTED_WRITER_WINDOW_DAYS, floor)).map(b => [b.role, b.version, b.segment_reader]).sort();

      await importRun('marked-run', SEGMENTED_WRITER_FLOOR, true);
      await heartbeat('marked-nonce', SEGMENTED_WRITER_FLOOR, true);
      expect(await seen()).toEqual([]);
      expect(await segmentedNow()).toBe(true);
      const raised = '99.0.0.0';
      expect(compareWriterVersions(SEGMENTED_WRITER_FLOOR, raised)).toBeLessThan(0);
      expect(await seen(raised)).toEqual([['importer', SEGMENTED_WRITER_FLOOR, true], ['resident', SEGMENTED_WRITER_FLOOR, true]]);

      await engine.executeRaw(`UPDATE ingest_log SET writer_version=$1 WHERE source_ref='marked-run'`, [below]);
      await engine.executeRaw(`UPDATE persistence_consumers SET version=$1 WHERE nonce='marked-nonce'`, [below]);
      expect(await segmentedNow()).toBe(false);
      expect((await blockersNow()).map(b => [b.role, b.principal, b.version, b.segment_reader]).sort())
        .toEqual([['importer', 'ingest:sync', below, true], ['resident', 'process:serve', below, true]]);
      expect((await segmentedStorageCheck(engine)).message).toContain(below);

      await engine.executeRaw(`UPDATE ingest_log SET writer_version=$1 WHERE source_ref='marked-run'`, [VERSION]);
      await engine.executeRaw(`UPDATE persistence_consumers SET version=$1 WHERE nonce='marked-nonce'`, [VERSION]);
      expect(await segmentedNow()).toBe(true);
      await importRun('unmarked-run', VERSION, null);
      await heartbeat('unmarked-nonce', '99.0.0.0', null);
      expect(await segmentedNow()).toBe(false);
      expect((await blockersNow()).map(b => [b.role, b.version, b.segment_reader]).sort())
        .toEqual([['importer', VERSION, false], ['resident', '99.0.0.0', false]]);
    }, 120_000);

    test('B3: a request an older binary admitted counts in any state, not only once committed', async () => inHome(async () => {
      await engine.setConfig('pages.segmented_storage', 'on');
      const requests = await requestFixture(engine);
      const queued = await requests.admit('queued-page');
      expect(queued.state).not.toBe('committed');
      expect(await segmentedNow()).toBe(true);
      await editRequest(engine, queued.id, "admitter_version='0.60.262.0',admitter_segment_reader=NULL");
      expect(await segmentedNow()).toBe(false);
      expect(await blockersNow()).toEqual([expect.objectContaining({ role: 'admitter', version: '0.60.262.0', segment_reader: false })]);
    }), 120_000);

    test('B4: an unreadable gate keeps the switch off, and doctor reports the gate as unreadable', async () => {
      await engine.setConfig('pages.segmented_storage', 'on');
      const denied = Object.create(engine, { executeRaw: { value: (sql: string, ...rest: unknown[]) => /persistence_requests/.test(sql)
        ? Promise.reject(Object.assign(new Error('permission denied for table persistence_requests'), { code: '42501' }))
        : (engine.executeRaw as (...a: unknown[]) => Promise<unknown>)(sql, ...rest) } }) as BrainEngine;
      expect(await readPageBodyPolicy(engine)).toMatchObject({ segmented: true });
      expect(await segmentedNow(denied)).toBe(false);
      expect(await readPageBodyPolicy(denied)).toMatchObject({ segmented: false, maxBytes: PAGE_MAX_BYTES });
      expect(await segmentedStorageCheck(denied)).toMatchObject({ details: { effective: 'unknown' } });
    }, 120_000);

    test('B4: the gate is read once per TTL per engine; a blocker that appears is seen when the entry expires, and doctor reads through', async () => {
      await engine.setConfig('pages.segmented_storage', 'on');
      _resetSegmentedWriterGateForTests();
      const start = Date.now();
      try {
        setSystemTime(new Date(start));
        const reads = segmentedWriterGateWork.reads;
        expect((await readPageBodyPolicy(engine)).segmented).toBe(true);
        expect((await readPageBodyPolicy(engine)).segmented).toBe(true);
        expect(segmentedWriterGateWork.reads - reads).toBe(1);
        await engine.executeRaw(`INSERT INTO ingest_log (source_id, source_type, source_ref, pages_updated, summary) VALUES ('default', 'import', 'older-binary', '[]'::jsonb, 'older binary run')`);
        setSystemTime(new Date(start + SEGMENTED_WRITER_GATE_TTL_MS - 1_000));
        expect((await readPageBodyPolicy(engine)).segmented).toBe(true);
        expect(segmentedWriterGateWork.reads - reads).toBe(1);
        setSystemTime(new Date(start + SEGMENTED_WRITER_GATE_TTL_MS + 1_000));
        expect((await readPageBodyPolicy(engine)).segmented).toBe(false);
        expect(segmentedWriterGateWork.reads - reads).toBe(2);
        expect((await segmentedStorageCheck(engine)).details).toMatchObject({ effective: 'off', blockers: [expect.objectContaining({ role: 'importer' })] });
        expect(segmentedWriterGateWork.reads - reads).toBe(3);
      } finally {
        setSystemTime();
      }
    }, 120_000);

    test('B4: a managed writer below the floor blocks 6 days after its last write and not 8 days after', async () => inHome(async () => {
      await engine.setConfig('pages.segmented_storage', 'on');
      const requests = await requestFixture(engine);
      const published = await requests.publish(await requests.admit('page'));
      await editRequest(engine, published.id, "admitter_version='0.60.200.0',consumer_version='0.60.200.0'");
      for (const [days, segmented] of [[6, false], [8, true]] as const) {
        await editRequest(engine, published.id, `created_at=now()-interval '${days} days',published_at=now()-interval '${days} days',completed_at=now()-interval '${days} days'`);
        expect({ days, segmented: await segmentedNow() }).toEqual({ days, segmented });
      }
    }), 120_000);

    test('B4: a stamped version the gate cannot parse blocks, even with the segment-reader mark', async () => inHome(async () => {
      await engine.setConfig('pages.segmented_storage', 'on');
      const requests = await requestFixture(engine);
      const published = await requests.publish(await requests.admit('page'));
      expect(await segmentedNow()).toBe(true);
      await editRequest(engine, published.id, "admitter_version='nightly-build'");
      expect(await segmentedNow()).toBe(false);
      expect(await blockersNow()).toEqual([expect.objectContaining({ role: 'admitter', version: 'nightly-build', segment_reader: true })]);
    }), 120_000);

    test('a failed read of pages.segmented_storage or pages.max_bytes keeps the switch off; it never reads as unset (on by default)', async () => {
      const failing = (key: string) => Object.create(engine, { getConfig: { value: (k: string) => k === key
        ? Promise.reject(Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }))
        : engine.getConfig(k) } }) as BrainEngine;
      await engine.setConfig('pages.segmented_storage', 'off');
      expect(await readPageBodyPolicy(failing('pages.segmented_storage'))).toMatchObject({ segmented: false, maxBytes: PAGE_MAX_BYTES });
      await engine.executeRaw("DELETE FROM config WHERE key='pages.segmented_storage'");
      expect(await segmentedNow()).toBe(true);
      expect(await readPageBodyPolicy(failing('pages.segmented_storage'))).toMatchObject({ segmented: false, maxBytes: PAGE_MAX_BYTES });
      await engine.setConfig('pages.max_bytes', String(8 * 1024 * 1024));
      expect(await readPageBodyPolicy(engine)).toMatchObject({ segmented: true, maxBytes: 8 * 1024 * 1024 });
      expect(await readPageBodyPolicy(failing('pages.max_bytes'))).toMatchObject({ segmented: false, maxBytes: PAGE_MAX_BYTES });
    }, 120_000);

    test('doctor: a hold left only by this host\'s writes from before it upgraded is information with its clear time; another host or a live older process on this host keeps the upgrade warning', async () => inHome(async () => {
      await engine.setConfig('pages.segmented_storage', 'on');
      const self = localHostId();
      const older = '0.60.290.0';
      expect(compareWriterVersions(older, SEGMENTED_WRITER_FLOOR)).toBeLessThan(0);
      await engine.executeRaw(`INSERT INTO ingest_log (source_id, source_type, source_ref, pages_updated, summary, writer_version, writer_host_id, writer_segment_reader, created_at)
        VALUES ('default', 'sync', 'self-before-upgrade', '[]'::jsonb, 'run', $1, $2::uuid, true, now() - interval '1 hour')`, [older, self]);
      await engine.executeRaw(`INSERT INTO persistence_consumers (host_id, pid, nonce, kind, mode, host_json_path, persistence_home, version, segment_reader, renewed_at)
        VALUES ($1::uuid, 4242, 'self-old-serve', 'serve', 'full', '/tmp/host.json', '/tmp', $2, true, now() - interval '10 minutes')`, [self, older]);
      expect(await segmentedNow()).toBe(false);
      // Until this host writes with a build that passes the gate, the rows cannot be told from an older gbrain still
      // writing here: the upgrade warning stays.
      expect(await segmentedStorageCheck(engine)).toMatchObject({ status: 'warn', fix: { argv: ['gbrain', 'upgrade'] } });
      await engine.logIngest({ source_type: 'sync', source_ref: 'self-after-upgrade', pages_updated: [], summary: 'this build' });
      expect(Number((await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM ingest_log WHERE writer_host_id=$1::uuid AND writer_segment_reader AND writer_version=$2", [self, VERSION]))[0]!.n)).toBe(1);
      // The lapsed older serve is matched only by a serve of this build started after it (PGLite writes no heartbeat).
      expect(await segmentedStorageCheck(engine)).toMatchObject({ status: 'warn', fix: { argv: ['gbrain', 'upgrade'] } });
      await engine.executeRaw(`INSERT INTO persistence_consumers (host_id, pid, nonce, kind, mode, host_json_path, persistence_home, version, segment_reader)
        VALUES ($1::uuid, 4343, 'self-new-serve', 'serve', 'full', '/tmp/host.json', '/tmp', $2, true)`, [self, VERSION]);
      expect(await segmentedNow()).toBe(false);
      const own = await segmentedStorageCheck(engine);
      expect(own).toMatchObject({ status: 'ok', severity: 'info', details: { effective: 'off' } });
      expect(own.fix).toBeUndefined();
      const listed = own.details!.blockers as Array<{ host_id: string; role: string; version: string; clears_at: string }>;
      expect(listed.map(b => [b.host_id, b.role, b.version]).sort()).toEqual([[self, 'importer', older], [self, 'resident', older]]);
      const clears = listed.map(b => b.clears_at).sort().at(-1)!;
      expect(own.message).toContain(self);
      expect(own.message).toContain(clears);
      expect(own.message).not.toContain('gbrain upgrade');

      // An older serve on this host that is still renewing its heartbeat is a process to restart: still a warning.
      await engine.executeRaw("UPDATE persistence_consumers SET renewed_at=now() WHERE nonce='self-old-serve'");
      expect(await segmentedStorageCheck(engine)).toMatchObject({ status: 'warn', fix: { argv: ['gbrain', 'upgrade'] } });
      await engine.executeRaw("UPDATE persistence_consumers SET renewed_at=now() - interval '10 minutes' WHERE nonce='self-old-serve'");
      expect(await segmentedStorageCheck(engine)).toMatchObject({ status: 'ok', severity: 'info' });

      const other = randomUUID();
      await engine.executeRaw(`INSERT INTO ingest_log (source_id, source_type, source_ref, pages_updated, summary, writer_version, writer_host_id, writer_segment_reader)
        VALUES ('default', 'import', 'other-host', '[]'::jsonb, 'run', $1, $2::uuid, true)`, [older, other]);
      const both = await segmentedStorageCheck(engine);
      expect(both).toMatchObject({ status: 'warn', fix: { argv: ['gbrain', 'upgrade'], actor: 'host_admin' } });
      expect(both.message).toContain(other);
    }), 120_000);

    test('doctor: an older gbrain still writing on this host (a cron import, an npx run) keeps the upgrade warning even after this build wrote', async () => inHome(async () => {
      await engine.setConfig('pages.segmented_storage', 'on');
      const self = localHostId();
      const older = '0.60.290.0';
      const oldRun = (type: string, ref: string, ago: string) => engine.executeRaw(`INSERT INTO ingest_log (source_id, source_type, source_ref, pages_updated, summary, writer_version, writer_host_id, writer_segment_reader, created_at)
        VALUES ('default', $1, $2, '[]'::jsonb, 'run', $3, $4::uuid, true, now() - $5::interval)`, [type, ref, older, self, ago]);
      const newRun = (type: string, ref: string, ago: string) => engine.executeRaw(`INSERT INTO ingest_log (source_id, source_type, source_ref, pages_updated, summary, writer_version, writer_host_id, writer_segment_reader, created_at)
        VALUES ('default', $1, $2, '[]'::jsonb, 'run', $3, $4::uuid, true, now() - $5::interval)`, [type, ref, VERSION, self, ago]);
      const verdict = async () => { const c = await segmentedStorageCheck(engine); return [c.status, c.fix?.argv?.join(' ') ?? null]; };
      const warn = ['warn', 'gbrain upgrade'];

      // A cron or npx gbrain on this host that imports, while this build only syncs: nothing this build wrote matches it.
      await oldRun('import', 'cron-import', '2 hours');
      await newRun('sync', 'this-build-sync', '1 hour');
      expect(await verdict()).toEqual(warn);
      // This build importing later makes the import look pre-upgrade again (the gate cannot tell; doctor says so only then).
      await newRun('import', 'this-build-import', '1 hour');
      expect(await verdict()).toEqual(['ok', null]);

      // An older sync that ran after this build's first sync is a second binary, even though this build synced again since.
      await newRun('sync', 'this-build-sync-again', '0 hours');
      await oldRun('sync', 'npx-sync', '30 minutes');
      expect(await verdict()).toEqual(warn);
      await engine.executeRaw("DELETE FROM ingest_log WHERE source_ref='npx-sync'");
      expect(await verdict()).toEqual(['ok', null]);

      // A managed write admitted by an older binary on this host, with no managed write of this build: warn.
      const requests = await requestFixture(engine);
      const admitted = await requests.admit('npx-page');
      await editRequest(engine, admitted.id, "admitter_version='0.60.290.0',created_at=now()-interval '3 hours'");
      expect((await blockersNow()).map(b => b.role)).toContain('admitter');
      expect(await verdict()).toEqual(warn);
    }), 120_000);

    test('explicit off keeps pages inline and doctor reports it as a choice', async () => {
      await engine.setConfig('pages.segmented_storage', 'off');
      expect((await importFromContent(engine, 'notes/off', content, { noEmbed: true })).status).toBe('imported');
      expect(await storage(engine, 'notes/off')).toBe('inline');
      expect(await segmentedStorageCheck(engine)).toMatchObject({ status: 'ok', severity: 'info', readiness_state: 'disabled_by_choice',
        details: { configured: 'off', effective: 'off' }, fix: { argv: ['gbrain', 'config', 'set', 'pages.segmented_storage', 'on'] } });
    }, 120_000);
  });
}
