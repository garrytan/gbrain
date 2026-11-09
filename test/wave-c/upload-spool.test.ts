/**
 * Wave C 1H-a, ceo-r3-native-4: an upload session of a strict source spools its parts to a 0600 file. Abort deletes the
 * file; a lapsed session's file is deleted by the owner sweep and only then is its reservation released (expiry skips a
 * session whose spool is still present); a spool file no session names is deleted at the sweep (owner start-up) once it is
 * older than a grace period (a session opening right now has its file before its row commits); a resumed
 * part re-sent with the same bytes is accepted from the spool's part record.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { operations } from '../../src/core/operations.ts';
import { _resetGitFirstGateForTests, _unregisterIndexSplitPageConsumerForTests, registerIndexSplitPageConsumer } from '../../src/core/persistence/git-first-gate.ts';
import { sweepSegmentStorage } from '../../src/core/persistence/journal.ts';
import { purgeSegmentStorage, stagingsHoldingClaim } from '../../src/core/facts/purge.ts';
import { uploadSpoolDir, uploadSpoolPath } from '../../src/core/persistence/upload-spool.ts';
import { durableGitRepo } from '../helpers/git-publication.ts';
import { managedBrain } from '../helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from '../helpers/test-backends.ts';
import { pageBody } from './helpers.ts';

const op = (name: string) => operations.find(o => o.name === name)!;
const hex = (text: string) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const strict = (engine: BrainEngine) => engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };
const reserved = async (engine: BrainEngine, id: string) => (await engine.executeRaw<{ state: string }>('SELECT state FROM page_body_stagings WHERE id = $1::uuid', [id]))[0]?.state;

for (const backend of testBackends()) describe(`[${backend}] upload spool lifecycle (ceo-r3-native-4)`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  beforeEach(() => { _resetGitFirstGateForTests(); registerIndexSplitPageConsumer({ run: async () => undefined }); });
  afterEach(() => { _unregisterIndexSplitPageConsumerForTests(); _resetGitFirstGateForTests(); });

  const begin = async (ctx: Parameters<ReturnType<typeof op>['handler']>[0], slug: string) => {
    const text = pageBody(300 * 1024, `MARKER${randomUUID().replace(/-/g, '')}`);
    const begun = await op('begin_page_upload').handler(ctx, { slug, mode: 'create', total_bytes: Buffer.byteLength(text), sha256: hex(text), request_id: randomUUID() }) as { upload_id: string };
    const first = text.slice(0, 100_000);
    await op('upload_page_part').handler(ctx, { upload_id: begun.upload_id, part: 0, text: first, part_sha256: hex(first) });
    return { id: begun.upload_id, first };
  };

  test('the spool is a 0600 file; a resent part is checked against its record; abort deletes the file', () => managedBrain(async ({ engine, ctx }) => {
    await strict(engine);
    const { id, first } = await begin(ctx, 'notes/abort');
    expect(statSync(uploadSpoolPath(id)).mode & 0o777).toBe(0o600);
    expect(await op('upload_page_part').handler(ctx, { upload_id: id, part: 0, text: first, part_sha256: hex(first) })).toMatchObject({ next_part: 1 });
    expect(await engine.executeRaw('SELECT count(*)::int AS n FROM page_body_staging_parts')).toEqual([{ n: 0 }]);
    await op('abort_page_upload').handler(ctx, { upload_id: id });
    expect(existsSync(uploadSpoolPath(id))).toBe(false);
    expect(await reserved(engine, id)).toBe('aborted');
  }, { databaseUrl, setup }), 120_000);

  test('a lapsed session expires only after the owner sweep removed its file; an unnamed spool file is removed too', () => managedBrain(async ({ engine, ctx }) => {
    await strict(engine);
    const { id } = await begin(ctx, 'notes/lapsed');
    await engine.executeRaw("UPDATE page_body_stagings SET idle_expires_at = now() - interval '1 second', hard_expires_at = now() - interval '1 second' WHERE id = $1::uuid", [id]);
    await engine.sweepSegments({ expireStagings: true });
    expect(await reserved(engine, id)).toBe('open');
    expect(existsSync(uploadSpoolPath(id))).toBe(true);
    const orphan = join(uploadSpoolDir(), `${randomUUID()}.spool`);
    writeFileSync(orphan, 'left by a crash', { mode: 0o600 });
    // A file no record names yet may be a session opening right now (its row commits after the file exists): it is kept
    // through the grace period and removed once it is older.
    const opening = join(uploadSpoolDir(), `${randomUUID()}.spool`);
    writeFileSync(opening, '', { mode: 0o600 });
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(orphan, old, old);
    await sweepSegmentStorage(engine);
    expect(existsSync(uploadSpoolPath(id))).toBe(false);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(opening)).toBe(true);
    utimesSync(opening, old, old);
    await sweepSegmentStorage(engine);
    expect(existsSync(opening)).toBe(false);
    expect(await reserved(engine, id)).toBe('expired');
  }, { databaseUrl, setup }), 120_000);

  test('ceo-r3-outside-5: purge discovery reads spool files, across a read boundary, and the purge removes the file', () => managedBrain(async ({ engine, ctx }) => {
    await strict(engine);
    const claim = 'alice-example prefers the blue launch plan';
    const filler = 'x'.repeat(1024 ** 2 - 10);
    const text = pageBody(300 * 1024, 'MARKERPURGE') + filler + claim + '\n';
    const begun = await op('begin_page_upload').handler(ctx, { slug: 'notes/purge-spool', mode: 'create', total_bytes: Buffer.byteLength(text), sha256: hex(text), request_id: randomUUID() }) as { upload_id: string };
    for (let part = 0, at = 0; at < text.length; part++, at += 700_000) {
      const slice = text.slice(at, at + 700_000);
      await op('upload_page_part').handler(ctx, { upload_id: begun.upload_id, part, text: slice, part_sha256: hex(slice) });
    }
    const plan = await stagingsHoldingClaim(engine, 'default', claim);
    expect(plan.stagings).toEqual([begun.upload_id]);
    expect((await stagingsHoldingClaim(engine, 'default', 'a sentence nobody wrote')).stagings).toEqual([]);
    await engine.transaction(tx => purgeSegmentStorage(tx, 'default', claim, plan, [], [], randomUUID()));
    expect(existsSync(uploadSpoolPath(begun.upload_id))).toBe(false);
    expect(await reserved(engine, begun.upload_id)).toBe('aborted');
  }, { databaseUrl, setup }), 120_000);
});
