/**
 * The Minion `purge` handler accepted `job.data.dryRun` but still executed
 * every destructive branch. These tests drive the registered handler itself
 * so the queued-job contract cannot drift away from the safe CLI/cycle paths.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { registerBuiltinHandlers } from '../src/commands/jobs.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

async function capturePurgeHandler(): Promise<(job: { data: Record<string, unknown> }) => Promise<unknown>> {
  const handlers = new Map<string, (job: { data: Record<string, unknown> }) => Promise<unknown>>();
  const worker = {
    register(name: string, handler: (job: { data: Record<string, unknown> }) => Promise<unknown>) {
      handlers.set(name, handler);
    },
  };
  await registerBuiltinHandlers(worker as never, engine, { quiet: true });
  const handler = handlers.get('purge');
  if (!handler) throw new Error('purge handler not registered');
  return handler;
}

async function seedPurgeCandidates(): Promise<void> {
  await engine.putPage('archive/expired-page', {
    title: 'Expired page',
    type: 'note',
    compiled_truth: 'This page is old enough to be permanently purged.',
    timeline: '',
    frontmatter: {},
    source_path: 'archive/expired-page.md',
  });
  await engine.softDeletePage('archive/expired-page');
  await engine.executeRaw(
    `UPDATE pages SET deleted_at = now() - interval '4 days'
     WHERE slug = 'archive/expired-page'`,
  );
  await engine.executeRaw(
    `INSERT INTO sources (id, name, archived, archived_at, archive_expires_at)
     VALUES ('expired-source', 'Expired source', true, now() - interval '4 days', now() - interval '1 day')`,
  );
  await engine.executeRaw(
    `INSERT INTO op_checkpoints (op, fingerprint, completed_keys, updated_at)
     VALUES ('test-op', 'expired-checkpoint', '[]'::jsonb, now() - interval '8 days')`,
  );
}

async function candidateCounts(): Promise<{
  pages: number;
  sources: number;
  checkpoints: number;
}> {
  const [pages, sources, checkpoints] = await Promise.all([
    engine.executeRaw<{ count: string }>(
      `SELECT count(*)::text AS count FROM pages WHERE slug = 'archive/expired-page'`,
    ),
    engine.executeRaw<{ count: string }>(`SELECT count(*)::text AS count FROM sources WHERE id = 'expired-source'`),
    engine.executeRaw<{ count: string }>(
      `SELECT count(*)::text AS count FROM op_checkpoints WHERE fingerprint = 'expired-checkpoint'`,
    ),
  ]);
  return {
    pages: Number(pages[0]?.count ?? 0),
    sources: Number(sources[0]?.count ?? 0),
    checkpoints: Number(checkpoints[0]?.count ?? 0),
  };
}

describe('Minion purge handler dry-run contract', () => {
  test('dryRun=true refuses unsupported preview and performs zero writes', async () => {
    await seedPurgeCandidates();
    const handler = await capturePurgeHandler();

    const result = await handler({
      data: { dryRun: true, scope: 'all', olderThanHours: 72 },
    });

    expect(result).toEqual({
      pagesPurged: 0,
      sourcesPurged: [],
      checkpointsPurged: 0,
      dryRun: true,
      previewSupported: false,
      skipped: true,
      reason: 'Safe purge preview is not supported; no data was deleted.',
    });
    expect(await candidateCounts()).toEqual({
      pages: 1,
      sources: 1,
      checkpoints: 1,
    });
  });

  test('dryRun=false preserves the destructive purge behavior', async () => {
    await seedPurgeCandidates();
    const handler = await capturePurgeHandler();

    const result = await handler({
      data: { dryRun: false, scope: 'all', olderThanHours: 72 },
    });

    expect(result).toEqual({
      pagesPurged: 1,
      sourcesPurged: ['expired-source'],
      checkpointsPurged: 1,
      dryRun: false,
    });
    expect(await candidateCounts()).toEqual({
      pages: 0,
      sources: 0,
      checkpoints: 0,
    });
  });
});
