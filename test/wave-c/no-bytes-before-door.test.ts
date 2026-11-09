/**
 * Wave C 1H-a, eng-r3-outside-1 (Critical, blocking): on a strict source with the git-first path on, no database row
 * holds a page's bytes before the door commit. A probe inside the publication transaction, run just before the door's
 * ref CAS, searches every table (each row cast to text, bytea included as hex) for a marker that appears only in the
 * page body. The write's own request intent is the admission journal, not page storage, and is excluded.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { operations } from '../../src/core/operations.ts';
import { _resetGitFirstGateForTests, _resetIndexSplitPageConsumerForTests, _unregisterIndexSplitPageConsumerForTests, registerIndexSplitPageConsumer } from '../../src/core/persistence/git-first-gate.ts';
import { durableGitRepo } from '../helpers/git-publication.ts';
import { managedBrain } from '../helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from '../helpers/test-backends.ts';
import { uploadSpoolPath } from '../../src/core/persistence/upload-spool.ts';
import { payloadTables, probeAny, probeHooks } from './payload-probe.ts';

const op = (name: string) => operations.find(o => o.name === name)!;
const putPage = op('put_page');
const hex = (text: string) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const strict = (engine: BrainEngine) => engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };
const body = (bytes: number, marker: string) => {
  let text = `---\ntype: note\ntitle: Probe\n---\n\n# ${marker}\n\n`;
  while (text.length < bytes) text += `Line about ${marker} and the launch plan for this week.\n`;
  return text;
};

for (const backend of testBackends()) describe(`[${backend}] eng-r3-outside-1: no page bytes in the database before the door commit`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  beforeEach(() => { _resetGitFirstGateForTests(); registerIndexSplitPageConsumer({ run: async () => undefined }); });
  afterEach(() => { _resetIndexSplitPageConsumerForTests(); _resetGitFirstGateForTests(); });

  test('a 512 KiB inline put on a strict source writes no content row before the door CAS', () => managedBrain(async ({ engine, ctx }) => {
    await strict(engine);
    const marker = `MARKER${randomUUID().replace(/-/g, '')}`;
    const requestId = randomUUID();
    const probe = probeHooks(marker, requestId);
    const result = await putPage.handler(ctx, { slug: 'notes/probe', content: body(512 * 1024, marker), request_id: requestId, wait_ms: 30_000 }) as Record<string, unknown>;
    probe.clear();
    expect(result).toMatchObject({ state: 'committed' });
    expect(probe.seen()).toEqual({ probed: true, tables: [] });
    expect(await payloadTables(engine, marker)).not.toEqual([]);
  }, { databaseUrl, setup }), 180_000);

  test('a 512 KiB upload session on a strict source spools to disk and writes no content row before the door CAS', () => managedBrain(async ({ engine, ctx }) => {
    await strict(engine);
    const marker = `MARKER${randomUUID().replace(/-/g, '')}`;
    const text = body(512 * 1024, marker);
    const requestId = randomUUID();
    const begun = await op('begin_page_upload').handler(ctx, { slug: 'notes/upload-probe', mode: 'create', total_bytes: Buffer.byteLength(text), sha256: hex(text), request_id: requestId }) as { upload_id: string };
    for (let part = 0, at = 0; at < text.length; part++, at += 200_000) {
      const slice = text.slice(at, at + 200_000);
      await op('upload_page_part').handler(ctx, { upload_id: begun.upload_id, part, text: slice, part_sha256: hex(slice) });
    }
    expect(await payloadTables(engine, marker)).toEqual([]);
    expect(existsSync(uploadSpoolPath(begun.upload_id))).toBe(true);
    const probe = probeAny(marker);
    const result = await op('commit_page_upload').handler(ctx, { upload_id: begun.upload_id, wait_ms: 30_000 }) as Record<string, unknown>;
    probe.clear();
    expect(result).toMatchObject({ state: 'committed' });
    expect(probe.seen()).toEqual({ probed: true, tables: [] });
    expect(existsSync(uploadSpoolPath(begun.upload_id))).toBe(false);
  }, { databaseUrl, setup }), 180_000);
});
