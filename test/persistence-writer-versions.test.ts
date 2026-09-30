import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { VERSION } from '../src/version.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { claimNextWrite, compactWriteReceipts, completeWrite } from '../src/core/persistence/journal.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { compareWriterVersions, UNSTAMPED_WRITER } from '../src/core/persistence/writer-versions.ts';
import { writerVersionCheck } from '../src/commands/doctor/checks/writer-version.ts';
import { editRequest, freshBrainFactory, readRequest, requestFixture } from './helpers/persistence-request-fixture.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

test('versions compare numerically on all four components', () => {
  expect(compareWriterVersions('0.60.10.0', '0.60.5.0')).toBe(1);
  expect(compareWriterVersions('0.60.4.9', '0.60.5.0')).toBe(-1);
  expect(compareWriterVersions('0.60.5.0', '0.60.5')).toBe(0);
  expect(compareWriterVersions('0.60.5.1-fixwave', '0.60.5.0')).toBe(1);
  expect(compareWriterVersions('not-a-version', '0.60.5.0')).toBeNull();
});

const databaseUrl = process.env.DATABASE_URL;
for (const kind of testBackends()) {
  describe(`writer-version stamps ${kind}`, () => {
    let factory: Awaited<ReturnType<typeof freshBrainFactory>>;
    let scratch: string;
    beforeAll(async () => {
      scratch = mkdtempSync(join(tmpdir(), 'gbrain-writer-versions-'));
      factory = await freshBrainFactory(kind, databaseUrl);
    }, 120_000);
    afterAll(async () => {
      await factory?.dispose();
      if (scratch) rmSync(scratch, { recursive: true, force: true });
    });
    const check = (name: string, fn: (engine: BrainEngine) => Promise<void>) => test(name, async () => {
      const engine = await factory.fresh();
      await withEnv({ GBRAIN_HOME: scratch, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, () => fn(engine));
    }, 120_000);

    check('admission stamps the admitter and a replay never rewrites it', async engine => {
      const requests = await requestFixture(engine);
      const requestId = randomUUID();
      const admitted = await requests.admit('page', requestId);
      expect(await readRequest(engine, admitted.id)).toMatchObject({ state: 'queued', admitter_version: VERSION, admitter_host_id: localHostId(),
        consumer_version: null, consumer_host_id: null, published_at: null });
      const other = randomUUID();
      await editRequest(engine, admitted.id, "admitter_version='0.60.9.0',admitter_host_id=$2::uuid", [other]);
      const replayed = await requests.admit('page', requestId);
      expect(replayed.id).toBe(admitted.id);
      expect(await readRequest(engine, admitted.id)).toMatchObject({ admitter_version: '0.60.9.0', admitter_host_id: other });
    });

    check('publication stamps the consumer and published_at; a failed completion does not', async engine => {
      const requests = await requestFixture(engine);
      const published = await requests.publish(await requests.admit('page'));
      const row = await readRequest(engine, published.id);
      expect(row).toMatchObject({ state: 'committed', consumer_version: VERSION, consumer_host_id: localHostId() });
      expect(row.published_at).not.toBeNull();
      expect(new Date(row.published_at as string).getTime()).toBe(new Date(row.completed_at as string).getTime());

      const failing = await requests.admit('failing');
      const claimed = (await claimNextWrite(engine, localHostId()))!;
      expect(claimed.id).toBe(failing.id);
      await engine.transaction(tx => completeWrite(tx, claimed, 'failed', {}, { code: 'storage_error', message: 'generic failure' }));
      expect(await readRequest(engine, failing.id)).toMatchObject({ state: 'failed', admitter_version: VERSION, consumer_version: null, consumer_host_id: null, published_at: null });
    });

    check('receipt compaction keeps the stamps', async engine => {
      const requests = await requestFixture(engine);
      const published = await requests.publish(await requests.admit('page'));
      const before = await readRequest(engine, published.id);
      await engine.transaction(async tx => {
        await declarePersistenceProtocol(tx);
        await tx.executeRaw("UPDATE persistence_effects SET state='committed' WHERE request_id=$1::uuid", [published.id]);
        await tx.executeRaw("UPDATE persistence_requests SET completed_at=now()-interval '3 days' WHERE id=$1::uuid", [published.id]);
      });
      expect(await compactWriteReceipts(engine, 1)).toBe(1);
      const after = await readRequest(engine, published.id);
      expect(after).toMatchObject({ compacted: true, admitter_version: before.admitter_version, admitter_host_id: before.admitter_host_id,
        consumer_version: before.consumer_version, consumer_host_id: before.consumer_host_id });
      expect(new Date(after.published_at as string).getTime()).toBe(new Date(before.published_at as string).getTime());
    });

    check('doctor: a pending request raises no warning and stamped current writers are ok', async engine => {
      const requests = await requestFixture(engine);
      await requests.publish(await requests.admit('published'));
      await requests.admit('pending');
      const result = await writerVersionCheck(engine);
      expect(result).toMatchObject({ name: 'writer_version', status: 'ok', details: { count: 0, truncated: false, hosts: [] } });
      expect((result.details!.observed as unknown[]).length).toBeGreaterThan(0);
      await editRequest(engine, (await requests.admit('unstamped-pending')).id, 'admitter_version=NULL,admitter_host_id=NULL');
      expect((await writerVersionCheck(engine)).status).toBe('ok');
    });

    check('doctor: an unstamped published request inside 7 days warns with the host UUID; outside the window it does not', async engine => {
      const root = join(scratch, `canonical-${randomUUID()}`); mkdirSync(root);
      await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
      const binding = await claimWorktree(engine, 'default', root);
      const requests = await requestFixture(engine, 'default');
      const admitted = await requests.admit('notes/unstamped', randomUUID(), binding);
      // An older binary admits and publishes without stamps.
      await editRequest(engine, admitted.id, "state='committed',completed_at=now(),admitter_version=NULL,admitter_host_id=NULL");
      const warned = await writerVersionCheck(engine);
      expect(warned.status).toBe('warn');
      expect(warned.message).toContain(`host ${localHostId()}`);
      expect(warned.message).toContain(`principal ${admitted.principal_kind}:${admitted.principal_id}`);
      expect(warned.message).toContain(UNSTAMPED_WRITER);
      expect(warned.message).toContain('A writer older than v0.60.5.0 may still delete database-only timeline rows');
      expect(warned.message).toContain('Run `gbrain upgrade` on that host');
      expect(warned.message).toContain('observation, not prevention');
      expect(warned.details).toMatchObject({ count: 2, truncated: false });
      expect(warned.details!.hosts).toContainEqual(expect.objectContaining({ host_id: localHostId(), role: 'consumer', consumer_version: UNSTAMPED_WRITER }));
      expect(warned.details!.hosts).toContainEqual(expect.objectContaining({ host_id: null, role: 'admitter', admitter_version: UNSTAMPED_WRITER }));

      await editRequest(engine, admitted.id, "completed_at=now()-interval '8 days',created_at=now()-interval '8 days'");
      expect(await writerVersionCheck(engine)).toMatchObject({ status: 'ok', details: { count: 0 } });
      // Older rows stay visible in writer status.
      const status = await runPersistenceAdministration(engine, 'writer_status', {});
      expect(status.local_host_id).toBe(localHostId());
      expect(status.writer_versions).toContainEqual(expect.objectContaining({ role: 'consumer', host_id: null, version: null, version_label: UNSTAMPED_WRITER,
        principal: `${admitted.principal_kind}:${admitted.principal_id}` }));
    });

    check('doctor: a request admitted before the cutoff and published after it is judged by its publication', async engine => {
      const requests = await requestFixture(engine);
      const admitted = await requests.admit('straddle');
      const published = await requests.publish(admitted);
      await editRequest(engine, published.id, `admitter_version=NULL,admitter_host_id=NULL,
        created_at=(SELECT writer_version_cutoff FROM persistence_brain WHERE singleton=1)-interval '1 hour'`);
      expect(await writerVersionCheck(engine)).toMatchObject({ status: 'ok', details: { count: 0 } });
      await editRequest(engine, published.id, 'consumer_version=NULL,consumer_host_id=NULL,published_at=NULL');
      const warned = await writerVersionCheck(engine);
      expect(warned).toMatchObject({ status: 'warn', details: { count: 1 } });
      expect(warned.details!.hosts).toEqual([expect.objectContaining({ role: 'consumer', consumer_version: UNSTAMPED_WRITER })]);
    });

    check('doctor: a recorded version older than v0.60.5.0 warns and newer ones compare numerically', async engine => {
      const requests = await requestFixture(engine);
      const published = await requests.publish(await requests.admit('old-writer'));
      await editRequest(engine, published.id, "consumer_version='0.60.10.0',admitter_version='0.60.5.0'");
      expect((await writerVersionCheck(engine)).status).toBe('ok');
      await editRequest(engine, published.id, "consumer_version='0.60.4.9'");
      const warned = await writerVersionCheck(engine);
      expect(warned).toMatchObject({ status: 'warn', details: { count: 1 } });
      expect(warned.details!.hosts).toEqual([expect.objectContaining({ host_id: localHostId(), role: 'consumer', consumer_version: '0.60.4.9' })]);
    });

    check('doctor never throws: an unreadable brain reports unknown health', async engine => {
      const broken = new Proxy(engine, { get(target, property) {
        if (property === 'executeRaw') return async () => { throw new Error('simulated read failure'); };
        const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
      } }) as BrainEngine;
      const result = await writerVersionCheck(broken);
      expect(result).toMatchObject({ name: 'writer_version', status: 'warn', details: { count: 'unknown' } });
      expect(result.message).toContain('Health is unknown');
    });
  });
}
