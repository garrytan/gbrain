import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { drainDerivedJobsOnce } from '../src/core/derived-worker.ts';
import { importFromContent, refreshDerivedStorageForPage } from '../src/core/import-file.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { DEFAULT_NOTE_MANIFEST_SCOPE_ID } from '../src/core/services/note-manifest-service.ts';

async function withSqliteEngine(
  run: (engine: SQLiteEngine, databasePath: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-derived-worker-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    await run(engine, databasePath);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
}

const content = [
  '---',
  'type: concept',
  'title: Derived Worker',
  'tags: [worker]',
  '---',
  '# Derived Worker',
  'Canonical content is committed before derived work.',
  '',
  '## Background Section',
  'This section is rebuilt by a durable worker.',
].join('\n');

test('derived worker drains durable jobs after a process restart', async () => {
  await withSqliteEngine(async (engine, databasePath) => {
    const slug = 'concepts/restart-worker-derived';
    const imported = await importFromContent(engine, slug, content, { deferDerived: true });
    expect(await engine.getChunks(slug)).toHaveLength(0);
    expect(await (engine as any).listDerivedJobs({ slug, status: 'pending' })).toHaveLength(3);
    await engine.disconnect();

    const reopened = new SQLiteEngine();
    try {
      await reopened.connect({ engine: 'sqlite', database_path: databasePath });
      await reopened.initSchema();

      const result = await drainDerivedJobsOnce(reopened, {
        leaseOwner: 'test-worker',
        maxJobs: 1,
      });

      expect(result.claimed).toBe(1);
      expect(result.completed).toBe(1);
      expect(result.failed).toBe(0);
      expect(await reopened.getChunks(slug)).not.toHaveLength(0);
      expect(await reopened.getNoteManifestEntry(DEFAULT_NOTE_MANIFEST_SCOPE_ID, slug)).toMatchObject({
        content_hash: imported.content_hash,
      });
      expect(await reopened.listNoteSectionEntries({
        scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
        page_slug: slug,
      })).not.toHaveLength(0);
      expect(await (reopened as any).listDerivedJobs({ slug, status: 'pending' })).toHaveLength(0);
      expect(await (reopened as any).getDerivedIndexState(
        DEFAULT_NOTE_MANIFEST_SCOPE_ID,
        slug,
        'note_sections',
      )).toMatchObject({
        status: 'ready',
        indexed_content_hash: imported.content_hash,
      });
    } finally {
      await reopened.disconnect();
    }
  });
});

test('derived worker yields before claiming work when foreground pressure is present', async () => {
  await withSqliteEngine(async (engine) => {
    const slug = 'concepts/foreground-worker-yield';
    await importFromContent(engine, slug, content, { deferDerived: true });

    const result = await drainDerivedJobsOnce(engine, {
      leaseOwner: 'test-worker',
      shouldYieldToForeground: () => true,
    });

    expect(result).toMatchObject({
      claimed: 0,
      completed: 0,
      failed: 0,
      deferred: 1,
    });
    expect(await engine.getChunks(slug)).toHaveLength(0);
    expect(await (engine as any).listDerivedJobs({ slug, status: 'pending' })).toHaveLength(3);
  });
});

test('derived worker releases a claimed lease when foreground pressure appears after claim', async () => {
  await withSqliteEngine(async (engine) => {
    const slug = 'concepts/foreground-worker-post-claim-yield';
    await importFromContent(engine, slug, content, { deferDerived: true });
    let pressureChecks = 0;
    let refreshed = false;

    const result = await drainDerivedJobsOnce(engine, {
      leaseOwner: 'test-worker',
      shouldYieldToForeground: () => {
        pressureChecks += 1;
        return pressureChecks === 2;
      },
      refreshPage: async () => {
        refreshed = true;
        throw new Error('refresh should not run');
      },
    });

    expect(result).toMatchObject({
      claimed: 1,
      completed: 0,
      failed: 0,
      deferred: 1,
    });
    expect(refreshed).toBe(false);
    expect(await engine.getChunks(slug)).toHaveLength(0);
    const pendingJobs = await (engine as any).listDerivedJobs({ slug, status: 'pending' });
    expect(pendingJobs).toHaveLength(3);
    expect(pendingJobs.every((job: any) => job.attempts === 0 && job.lease_owner === null)).toBe(true);
  });
});

test('stale refresh owner cannot complete or clear a reclaimed active job', async () => {
  await withSqliteEngine(async (engine) => {
    const slug = 'concepts/stale-refresh-owner';
    const imported = await importFromContent(engine, slug, content, { deferDerived: true });
    const firstClaim = await (engine as any).claimNextDerivedJob({
      lease_owner: 'worker-a',
      lease_duration_ms: 60_000,
    });
    expect(firstClaim?.artifact_kind).toBeDefined();
    (engine as any).database.run(`DELETE FROM derived_jobs WHERE slug = ? AND id != ?`, [
      slug,
      firstClaim.id,
    ]);

    (engine as any).database.run(`UPDATE derived_jobs SET lease_expires_at = ? WHERE id = ?`, [
      '2000-01-01T00:00:00.000Z',
      firstClaim.id,
    ]);
    const secondClaim = await (engine as any).claimNextDerivedJob({
      lease_owner: 'worker-b',
      lease_duration_ms: 60_000,
    });
    expect(secondClaim).toMatchObject({
      id: firstClaim.id,
      lease_owner: 'worker-b',
      attempts: 2,
    });

    const staleRefresh = await refreshDerivedStorageForPage(engine, slug, {
      expectedContentHash: imported.content_hash,
      leaseOwner: 'worker-a',
      leaseArtifactKind: firstClaim.artifact_kind,
    });

    expect(staleRefresh).toMatchObject({
      status: 'skipped',
      chunks: 0,
    });
    expect(await engine.getChunks(slug)).toHaveLength(0);
    expect(await (engine as any).listDerivedJobs({ slug, status: 'running' })).toMatchObject([
      expect.objectContaining({
        id: firstClaim.id,
        lease_owner: 'worker-b',
      }),
    ]);
    expect(await (engine as any).getDerivedIndexState(
      DEFAULT_NOTE_MANIFEST_SCOPE_ID,
      slug,
      firstClaim.artifact_kind,
    )).not.toMatchObject({
      status: 'ready',
      indexed_content_hash: imported.content_hash,
    });
  });
});

test('derived worker yields between jobs during a foreground burst', async () => {
  await withSqliteEngine(async (engine) => {
    for (const suffix of ['a', 'b']) {
      const slug = `concepts/worker-burst-${suffix}`;
      await (engine as any).enqueueDerivedJob({
        scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
        slug,
        artifact_kind: 'page_chunks',
        target_content_hash: `hash-${suffix}`,
        manifest_path: `${slug}.md`,
        derived_parameters: {
          manifest_path: `${slug}.md`,
          extractor_version: 'recursive-chunks-v1',
          derived_schema_version: 'page-derived-v1',
        },
      });
    }

    let pressureChecks = 0;
    const result = await drainDerivedJobsOnce(engine, {
      leaseOwner: 'burst-worker',
      maxJobs: 2,
      shouldYieldToForeground: () => {
        pressureChecks += 1;
        return pressureChecks === 3;
      },
      refreshPage: async (job) => {
        await (engine as any).markDerivedIndexReady({
          scope_id: job.scope_id,
          slug: job.slug,
          artifact_kind: job.artifact_kind,
          target_content_hash: job.target_content_hash,
          indexed_content_hash: job.target_content_hash,
          manifest_path: job.manifest_path,
          derived_parameters: job.derived_parameters,
          lease_owner: 'burst-worker',
          require_active_job: true,
        });
        return {
          slug: job.slug,
          status: 'imported',
          chunks: 1,
          content_hash: job.target_content_hash,
        };
      },
    });

    expect(result).toMatchObject({
      claimed: 1,
      completed: 1,
      failed: 0,
      deferred: 1,
    });
    expect(await (engine as any).listDerivedJobs({ status: 'pending' })).toHaveLength(1);
    expect(await (engine as any).listDerivedJobs({ status: 'running' })).toHaveLength(0);
  });
});

test('derived worker releases a claimed lease when abort happens during refresh', async () => {
  await withSqliteEngine(async (engine) => {
    const slug = 'concepts/abort-during-refresh';
    await (engine as any).enqueueDerivedJob({
      scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
      slug,
      artifact_kind: 'page_chunks',
      target_content_hash: 'hash-abort',
      manifest_path: `${slug}.md`,
      derived_parameters: {
        manifest_path: `${slug}.md`,
        extractor_version: 'recursive-chunks-v1',
        derived_schema_version: 'page-derived-v1',
      },
    });
    const controller = new AbortController();

    const result = await drainDerivedJobsOnce(engine, {
      leaseOwner: 'abort-worker',
      abortSignal: controller.signal,
      refreshPage: async (_job, context) => {
        expect(context.signal).toBe(controller.signal);
        controller.abort();
        throw new Error('refresh aborted');
      },
    });

    expect(result).toMatchObject({
      claimed: 1,
      completed: 0,
      failed: 0,
      deferred: 1,
    });
    expect(await (engine as any).listDerivedJobs({ slug, status: 'pending' })).toMatchObject([
      expect.objectContaining({
        attempts: 0,
        lease_owner: null,
      }),
    ]);
  });
});

test('refreshDerivedStorageForPage skips without completing a lease when aborted before mutation', async () => {
  await withSqliteEngine(async (engine) => {
    const slug = 'concepts/abort-refresh-derived';
    const imported = await importFromContent(engine, slug, content, { deferDerived: true });
    const claimed = await (engine as any).claimNextDerivedJob({
      lease_owner: 'abort-worker',
      lease_duration_ms: 60_000,
    });
    const controller = new AbortController();
    controller.abort();

    const refreshed = await refreshDerivedStorageForPage(engine, slug, {
      expectedContentHash: imported.content_hash,
      leaseOwner: 'abort-worker',
      leaseArtifactKind: claimed.artifact_kind,
      signal: controller.signal,
    });

    expect(refreshed).toMatchObject({
      status: 'skipped',
      chunks: 0,
    });
    expect(await engine.getChunks(slug)).toHaveLength(0);
    expect(await (engine as any).listDerivedJobs({ slug, status: 'running' })).toMatchObject([
      expect.objectContaining({
        id: claimed.id,
        attempts: 1,
        lease_owner: 'abort-worker',
      }),
    ]);
  });
});

test('derived worker records retries and final failures', async () => {
  await withSqliteEngine(async (engine) => {
    const slug = 'concepts/failing-worker-derived';
    await (engine as any).enqueueDerivedJob({
      scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
      slug,
      artifact_kind: 'page_chunks',
      target_content_hash: 'hash-1',
      manifest_path: `${slug}.md`,
      derived_parameters: {
        manifest_path: `${slug}.md`,
        extractor_version: 'recursive-chunks-v1',
        derived_schema_version: 'page-derived-v1',
      },
    });

    const first = await drainDerivedJobsOnce(engine, {
      leaseOwner: 'test-worker',
      maxJobs: 1,
      maxAttempts: 2,
      refreshPage: async () => {
        throw new Error('refresh failed');
      },
    });
    expect(first).toMatchObject({ claimed: 1, completed: 0, failed: 1 });
    const retriedJobs = await (engine as any).listDerivedJobs({ slug, artifact_kind: 'page_chunks' });
    expect(retriedJobs[0]).toMatchObject({
      status: 'pending',
      attempts: 1,
      last_error: 'refresh failed',
    });

    const second = await drainDerivedJobsOnce(engine, {
      leaseOwner: 'test-worker',
      maxJobs: 1,
      maxAttempts: 2,
      refreshPage: async () => {
        throw new Error('refresh failed again');
      },
    });
    expect(second).toMatchObject({ claimed: 1, completed: 0, failed: 1 });
    const failedJobs = await (engine as any).listDerivedJobs({ slug, artifact_kind: 'page_chunks' });
    expect(failedJobs[0]).toMatchObject({
      status: 'failed',
      attempts: 2,
      last_error: 'refresh failed again',
    });
    expect(await (engine as any).getDerivedIndexState(
      DEFAULT_NOTE_MANIFEST_SCOPE_ID,
      slug,
      'page_chunks',
    )).toMatchObject({
      status: 'failed',
      last_error: 'refresh failed again',
    });
  });
});
