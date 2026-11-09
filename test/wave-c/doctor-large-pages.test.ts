/**
 * Wave C 1H-a, T-DX7 (spec §3.8): doctor `large_pages` reports each source's readiness for the git-first strict path
 * (strict or not, on or off and why, pending and held heads, full or shallow history), the unsplit and database-tier
 * ceilings, the floor and the writers below it, and warns with a fix when an older writer keeps the path off, a head is
 * held or a strict checkout is shallow. A strict upload over the unsplit ceiling refuses `file_too_large` with a reason.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Check } from '../../src/commands/doctor.ts';
import { largePagesEntry } from '../../src/commands/doctor/checks/large-pages.ts';
import type { DoctorContext } from '../../src/commands/doctor/context.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { operations } from '../../src/core/operations.ts';
import { PAGE_MAX_BYTES } from '../../src/core/page-size-policy.ts';
import { _resetGitFirstGateForTests, _unregisterIndexSplitPageConsumerForTests, registerIndexSplitPageConsumer } from '../../src/core/persistence/git-first-gate.ts';
import { durableGitRepo, git } from '../helpers/git-publication.ts';
import { managedBrain } from '../helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from '../helpers/test-backends.ts';
import { pageBody, write } from './helpers.ts';

const op = (name: string) => operations.find(o => o.name === name)!;
const strict = (engine: BrainEngine) => engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };
const doctor = async (engine: BrainEngine) => (await largePagesEntry.run({ engine, sourceIds: ['default'] } as unknown as DoctorContext) as Check[])[0]!;
type Source = { source_id: string; strict: boolean; git_first: string; off_reason: string | null; pending_heads: number; held_heads: number; history: string };
const sourceOf = (check: Check) => (check.details as { sources: Source[] }).sources[0]!;

for (const backend of testBackends()) describe(`[${backend}] doctor large_pages (T-DX7)`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  beforeEach(() => { _resetGitFirstGateForTests(); registerIndexSplitPageConsumer({ run: async () => undefined }); });
  afterEach(() => { _unregisterIndexSplitPageConsumerForTests(); _resetGitFirstGateForTests(); });

  test('a non-strict source: ok, the path off with reason not_strict, both ceilings reported', () => managedBrain(async ({ engine }) => {
    const check = await doctor(engine);
    expect(check.status).toBe('ok');
    expect(sourceOf(check)).toMatchObject({ source_id: 'default', strict: false, git_first: 'off', off_reason: 'not_strict' });
    expect(check.details).toMatchObject({ engine: engine.kind, unsplit_ceiling_bytes: PAGE_MAX_BYTES, index_consumer: true, writers_below_floor: [] });
    expect(typeof (check.details as { database_tier_ceiling_bytes: unknown }).database_tier_ceiling_bytes).toBe('number');
  }, { databaseUrl, setup }), 60_000);

  test('a strict source with a consumer: ok and on, full history; without a consumer: off with reason no_index_consumer', () => managedBrain(async ({ engine }) => {
    await strict(engine);
    const on = await doctor(engine);
    expect(on.status).toBe('ok');
    expect(sourceOf(on)).toMatchObject({ strict: true, git_first: 'on', off_reason: null, history: 'full', pending_heads: 0, held_heads: 0 });
    _unregisterIndexSplitPageConsumerForTests();
    expect(sourceOf(await doctor(engine))).toMatchObject({ git_first: 'off', off_reason: 'no_index_consumer' });
  }, { databaseUrl, setup }), 60_000);

  test('a writer below the floor: warn naming its version and host, with the upgrade fix', () => managedBrain(async ({ engine }) => {
    await strict(engine);
    const host = randomUUID();
    await engine.executeRaw(`INSERT INTO ingest_log (source_type, source_ref, writer_version, writer_host_id, writer_segment_reader, created_at)
      VALUES ('sync', 'older-binary', '0.60.1.0', $1::uuid, true, now() - interval '1 day')`, [host]);
    const check = await doctor(engine);
    expect(check.status).toBe('warn');
    expect(sourceOf(check)).toMatchObject({ git_first: 'off', off_reason: 'writer_floor' });
    expect((check.details as { writers_below_floor: unknown[] }).writers_below_floor).toEqual([expect.objectContaining({ version: '0.60.1.0', host_id: host })]);
    expect(check.message).toContain('0.60.1.0');
    expect(check.message).toContain(host);
    expect(check.fix).toMatchObject({ argv: ['gbrain', 'upgrade'], actor: 'host_admin', verify: { argv: ['gbrain', 'doctor', '--only', 'large_pages', '--json'] } });
  }, { databaseUrl, setup }), 60_000);

  test('a pending head counts; a held head warns with the read-only receipt of its write', () => managedBrain(async ({ engine, ctx }) => {
    await strict(engine);
    const row = await write(engine, ctx, 'notes/held', pageBody(2 * 1024 ** 2, 'MARKERHELD'), 'put');
    expect(row.state).toBe('indexing');
    expect(sourceOf(await doctor(engine))).toMatchObject({ pending_heads: 1, held_heads: 0 });
    await engine.executeRaw("UPDATE page_pending_heads SET hold_code = 'index_failed' WHERE slug = 'notes/held'");
    const check = await doctor(engine);
    expect(check.status).toBe('warn');
    expect(sourceOf(check)).toMatchObject({ pending_heads: 1, held_heads: 1 });
    expect(check.fix).toMatchObject({ argv: ['gbrain', 'write-request', row.id, '--json'], actor: 'agent' });
  }, { databaseUrl, setup }), 120_000);

  test('a shallow strict checkout warns with the unshallow fix', () => managedBrain(async ({ engine, root }) => {
    await strict(engine);
    // A managed source's path cannot move, so its own checkout is made shallow: a .git/shallow entry is what a depth clone writes.
    writeFileSync(join(git(root, 'rev-parse', '--absolute-git-dir').trim(), 'shallow'), `${git(root, 'rev-parse', 'HEAD').trim()}\n`);
    const check = await doctor(engine);
    expect(check.status).toBe('warn');
    expect(sourceOf(check)).toMatchObject({ history: 'shallow' });
    expect(check.fix).toMatchObject({ argv: ['git', 'fetch', '--unshallow'], actor: 'host_admin' });
  }, { databaseUrl, setup }), 60_000);

  test('a strict upload over the unsplit ceiling refuses file_too_large with reason switch_off', () => managedBrain(async ({ engine, ctx }) => {
    await strict(engine);
    const total = PAGE_MAX_BYTES + 1;
    const refused = await Promise.resolve(op('begin_page_upload').handler(ctx, { slug: 'notes/over', mode: 'create', total_bytes: total,
      sha256: createHash('sha256').update('x').digest('hex'), request_id: randomUUID() })).then(() => null, (error: unknown) => error as { code?: string; canonical?: string; reason?: string; details?: { reason?: string } });
    expect(refused?.canonical ?? refused?.code).toBe('file_too_large');
    expect(refused?.reason ?? refused?.details?.reason).toBe('switch_off');
  }, { databaseUrl, setup }), 60_000);
});
