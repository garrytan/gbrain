import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { importFromContent } from '../src/core/import-file.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { DEFAULT_NOTE_MANIFEST_SCOPE_ID } from '../src/core/services/note-manifest-service.ts';

type TestEngine = SQLiteEngine | PGLiteEngine;

async function withEngines(run: (engine: TestEngine, label: string) => Promise<void>): Promise<void> {
  const tempPaths: string[] = [];
  try {
    {
      const dir = mkdtempSync(join(tmpdir(), 'mbrain-derived-jobs-sqlite-'));
      tempPaths.push(dir);
      const engine = new SQLiteEngine();
      await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
      await engine.initSchema();
      await run(engine, 'sqlite');
      await engine.disconnect();
    }
    {
      const dir = mkdtempSync(join(tmpdir(), 'mbrain-derived-jobs-pglite-'));
      tempPaths.push(dir);
      const engine = new PGLiteEngine();
      await engine.connect({ engine: 'pglite', database_path: dir });
      await engine.initSchema();
      await run(engine, 'pglite');
      await engine.disconnect();
    }
  } finally {
    while (tempPaths.length > 0) {
      rmSync(tempPaths.pop()!, { recursive: true, force: true });
    }
  }
}

describe('derived job engine APIs', () => {
  test('markDerivedIndexReady participates in the engine transaction boundary', async () => {
    await withEngines(async (engine, label) => {
      const api = engine as any;
      const originalTransaction = api.transaction.bind(api);
      let transactionCalls = 0;
      api.transaction = async (fn: any) => {
        transactionCalls += 1;
        return originalTransaction(fn);
      };

      const slug = `concepts/${label}-ready-transaction`;
      await api.enqueueDerivedJob({
        scope_id: 'workspace:default',
        slug,
        artifact_kind: 'page_chunks',
        target_content_hash: 'hash-1',
        manifest_path: `${slug}.md`,
        derived_parameters: {
          extractor_version: 'recursive-chunks-v1',
          derived_schema_version: 'page-derived-v1',
        },
      });

      await api.markDerivedIndexReady({
        scope_id: 'workspace:default',
        slug,
        artifact_kind: 'page_chunks',
        target_content_hash: 'hash-1',
        indexed_content_hash: 'hash-1',
        manifest_path: `${slug}.md`,
        derived_parameters: {
          extractor_version: 'recursive-chunks-v1',
          derived_schema_version: 'page-derived-v1',
        },
        require_active_job: true,
      });

      expect(transactionCalls).toBeGreaterThanOrEqual(2);
    });
  });

  test('pglite ready completion waits behind the derived job serialization lock', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-derived-ready-lock-pglite-'));
    const engine = new PGLiteEngine();
    try {
      await engine.connect({ engine: 'pglite', database_path: dir });
      await engine.initSchema();
      const api = engine as any;
      const slug = 'concepts/pglite-ready-lock';

      await api.enqueueDerivedJob({
        scope_id: 'workspace:default',
        slug,
        artifact_kind: 'note_sections',
        target_content_hash: 'hash-2',
        manifest_path: `${slug}.md`,
        derived_parameters: {
          manifest_path: `${slug}.md`,
          extractor_version: 'phase2-sections-v1',
          derived_schema_version: 'page-derived-v1',
        },
      });

      let releaseLock!: () => void;
      let lockAcquired!: () => void;
      const locked = new Promise<void>((resolve) => {
        lockAcquired = resolve;
      });
      const release = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      const holder = api.transaction(async (tx: any) => {
        await tx.db.query(`LOCK TABLE derived_jobs IN EXCLUSIVE MODE`);
        lockAcquired();
        await release;
      });
      await locked;

      let settled = false;
      const completion = api.markDerivedIndexReady({
        scope_id: 'workspace:default',
        slug,
        artifact_kind: 'note_sections',
        target_content_hash: 'hash-1',
        indexed_content_hash: 'hash-1',
        manifest_path: `${slug}.md`,
        derived_parameters: {
          manifest_path: `${slug}.md`,
          extractor_version: 'phase2-sections-v1',
          derived_schema_version: 'page-derived-v1',
        },
        require_active_job: true,
      }).finally(() => {
        settled = true;
      });

      await new Promise(resolve => setTimeout(resolve, 25));
      expect(settled).toBe(false);

      releaseLock();
      await holder;
      await completion;
    } finally {
      await engine.disconnect();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('enqueueDerivedJob coalesces identical pending work and supersedes stale pending work', async () => {
    await withEngines(async (engine, label) => {
      const api = engine as any;
      const first = await api.enqueueDerivedJob({
        scope_id: 'workspace:default',
        slug: `concepts/${label}-derived`,
        artifact_kind: 'note_sections',
        target_content_hash: 'hash-1',
        manifest_path: `concepts/${label}-derived.md`,
        derived_parameters: {
          extractor_version: 'phase2-sections-v1',
          derived_schema_version: 'page-derived-v1',
        },
      });
      const duplicate = await api.enqueueDerivedJob({
        scope_id: 'workspace:default',
        slug: `concepts/${label}-derived`,
        artifact_kind: 'note_sections',
        target_content_hash: 'hash-1',
        manifest_path: `concepts/${label}-derived.md`,
        derived_parameters: {
          extractor_version: 'phase2-sections-v1',
          derived_schema_version: 'page-derived-v1',
        },
      });

      expect(duplicate.id).toBe(first.id);
      expect(duplicate.status).toBe('pending');

      const newer = await api.enqueueDerivedJob({
        scope_id: 'workspace:default',
        slug: `concepts/${label}-derived`,
        artifact_kind: 'note_sections',
        target_content_hash: 'hash-2',
        manifest_path: `concepts/${label}-derived.md`,
        derived_parameters: {
          extractor_version: 'phase2-sections-v1',
          derived_schema_version: 'page-derived-v1',
        },
      });

      expect(newer.id).not.toBe(first.id);
      const jobs = await api.listDerivedJobs({
        scope_id: 'workspace:default',
        slug: `concepts/${label}-derived`,
        artifact_kind: 'note_sections',
      });
      expect(jobs.map((job: any) => job.status).sort()).toEqual(['pending', 'superseded']);
      expect(jobs.find((job: any) => job.id === first.id)?.status).toBe('superseded');

      const state = await api.getDerivedIndexState(
        'workspace:default',
        `concepts/${label}-derived`,
        'note_sections',
      );
      expect(state).toMatchObject({
        scope_id: 'workspace:default',
        slug: `concepts/${label}-derived`,
        artifact_kind: 'note_sections',
        target_content_hash: 'hash-2',
        indexed_content_hash: null,
        status: 'pending',
      });
    });
  });

  test('claimNextDerivedJob leases pending work and reclaims expired running work', async () => {
    await withEngines(async (engine, label) => {
      const api = engine as any;
      const slug = `concepts/${label}-lease-derived`;
      const pending = await api.enqueueDerivedJob({
        scope_id: 'workspace:default',
        slug,
        artifact_kind: 'note_manifest',
        target_content_hash: 'hash-1',
        manifest_path: `${slug}.md`,
        derived_parameters: {
          manifest_path: `${slug}.md`,
          extractor_version: 'phase2-structural-v1',
          derived_schema_version: 'page-derived-v1',
        },
      });

      const claimed = await api.claimNextDerivedJob({
        lease_owner: `${label}-worker-a`,
        lease_duration_ms: 60_000,
      });
      expect(claimed).toMatchObject({
        id: pending.id,
        status: 'running',
        attempts: 1,
        lease_owner: `${label}-worker-a`,
      });
      expect(await api.claimNextDerivedJob({ lease_owner: `${label}-worker-b` })).toBeNull();

      if (label === 'sqlite') {
        api.database.run(`UPDATE derived_jobs SET lease_expires_at = ? WHERE id = ?`, [
          '2000-01-01T00:00:00.000Z',
          pending.id,
        ]);
      } else {
        await api.db.query(`UPDATE derived_jobs SET lease_expires_at = $1 WHERE id = $2`, [
          '2000-01-01T00:00:00.000Z',
          pending.id,
        ]);
      }

      const reclaimed = await api.claimNextDerivedJob({ lease_owner: `${label}-worker-b` });
      expect(reclaimed).toMatchObject({
        id: pending.id,
        status: 'running',
        attempts: 2,
        lease_owner: `${label}-worker-b`,
      });
    });
  });

  test('markDerivedJobFailed retries until max attempts then marks derived state failed', async () => {
    await withEngines(async (engine, label) => {
      const api = engine as any;
      const slug = `concepts/${label}-failed-derived`;
      await api.enqueueDerivedJob({
        scope_id: 'workspace:default',
        slug,
        artifact_kind: 'note_sections',
        target_content_hash: 'hash-1',
        manifest_path: `${slug}.md`,
        derived_parameters: {
          manifest_path: `${slug}.md`,
          extractor_version: 'phase2-sections-v1',
          derived_schema_version: 'page-derived-v1',
        },
      });

      const first = await api.claimNextDerivedJob({ lease_owner: `${label}-worker` });
      expect(first?.attempts).toBe(1);
      const retried = await api.markDerivedJobFailed({
        id: first.id,
        error: 'temporary failure',
        max_attempts: 2,
      });
      expect(retried).toMatchObject({
        status: 'pending',
        attempts: 1,
        last_error: 'temporary failure',
        lease_owner: null,
      });

      const second = await api.claimNextDerivedJob({ lease_owner: `${label}-worker` });
      expect(second?.attempts).toBe(2);
      const failed = await api.markDerivedJobFailed({
        id: second.id,
        error: 'permanent failure',
        max_attempts: 2,
      });
      expect(failed).toMatchObject({
        status: 'failed',
        attempts: 2,
        last_error: 'permanent failure',
        lease_owner: null,
      });
      expect(await api.getDerivedIndexState('workspace:default', slug, 'note_sections')).toMatchObject({
        status: 'failed',
        target_content_hash: 'hash-1',
        indexed_content_hash: null,
        last_error: 'permanent failure',
      });
    });
  });

  test('releaseDerivedJobLease returns a claimed job to pending without burning an attempt', async () => {
    await withEngines(async (engine, label) => {
      const api = engine as any;
      const slug = `concepts/${label}-release-derived`;
      await api.enqueueDerivedJob({
        scope_id: 'workspace:default',
        slug,
        artifact_kind: 'note_manifest',
        target_content_hash: 'hash-1',
        manifest_path: `${slug}.md`,
        derived_parameters: {
          manifest_path: `${slug}.md`,
          extractor_version: 'phase2-structural-v1',
          derived_schema_version: 'page-derived-v1',
        },
      });

      const claimed = await api.claimNextDerivedJob({ lease_owner: `${label}-worker-a` });
      expect(claimed).toMatchObject({
        status: 'running',
        attempts: 1,
        lease_owner: `${label}-worker-a`,
      });

      const ownerless = await api.releaseDerivedJobLease({ id: claimed.id });
      expect(ownerless).toMatchObject({
        status: 'running',
        attempts: 1,
        lease_owner: `${label}-worker-a`,
      });

      const ignored = await api.releaseDerivedJobLease({
        id: claimed.id,
        lease_owner: `${label}-worker-b`,
      });
      expect(ignored).toMatchObject({
        status: 'running',
        attempts: 1,
        lease_owner: `${label}-worker-a`,
      });

      const released = await api.releaseDerivedJobLease({
        id: claimed.id,
        lease_owner: `${label}-worker-a`,
      });
      expect(released).toMatchObject({
        status: 'pending',
        attempts: 0,
        lease_owner: null,
        lease_expires_at: null,
      });
    });
  });

  test('ready and failure completion respect the active lease owner when supplied', async () => {
    await withEngines(async (engine, label) => {
      const api = engine as any;
      const slug = `concepts/${label}-lease-owner-derived`;
      await api.enqueueDerivedJob({
        scope_id: 'workspace:default',
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

      const claimed = await api.claimNextDerivedJob({
        lease_owner: `${label}-worker-a`,
        lease_duration_ms: 60_000,
      });
      expect(claimed?.lease_owner).toBe(`${label}-worker-a`);

      const ignoredFailure = await api.markDerivedJobFailed({
        id: claimed.id,
        error: 'wrong owner',
        lease_owner: `${label}-worker-b`,
        max_attempts: 1,
      });
      expect(ignoredFailure).toMatchObject({
        status: 'running',
        lease_owner: `${label}-worker-a`,
        last_error: null,
      });

      const staleCompletion = await api.markDerivedIndexReady({
        scope_id: 'workspace:default',
        slug,
        artifact_kind: 'page_chunks',
        target_content_hash: 'hash-1',
        indexed_content_hash: 'hash-1',
        manifest_path: `${slug}.md`,
        derived_parameters: {
          manifest_path: `${slug}.md`,
          extractor_version: 'recursive-chunks-v1',
          derived_schema_version: 'page-derived-v1',
        },
        lease_owner: `${label}-worker-b`,
        require_active_job: true,
      });
      expect(staleCompletion.status).toBe('pending');
      expect(await api.listDerivedJobs({ slug, status: 'running' })).toHaveLength(1);

      const ready = await api.markDerivedIndexReady({
        scope_id: 'workspace:default',
        slug,
        artifact_kind: 'page_chunks',
        target_content_hash: 'hash-1',
        indexed_content_hash: 'hash-1',
        manifest_path: `${slug}.md`,
        derived_parameters: {
          manifest_path: `${slug}.md`,
          extractor_version: 'recursive-chunks-v1',
          derived_schema_version: 'page-derived-v1',
        },
        lease_owner: `${label}-worker-a`,
        require_active_job: true,
      });
      expect(ready.status).toBe('ready');
      expect(await api.listDerivedJobs({ slug })).toHaveLength(0);
    });
  });

  test('deletePage removes derived jobs and index state for the deleted slug', async () => {
    await withEngines(async (engine, label) => {
      const api = engine as any;
      const slug = `concepts/${label}-delete-derived-state`;
      await api.putPage(slug, {
        type: 'concept',
        title: 'Delete Derived State',
        compiled_truth: 'Canonical page for derived delete cleanup.',
        timeline: '',
        frontmatter: {},
        content_hash: 'hash-1',
      });
      await api.enqueueDerivedJob({
        scope_id: 'workspace:default',
        slug,
        artifact_kind: 'page_chunks',
        target_content_hash: 'hash-1',
        manifest_path: `${slug}.md`,
        derived_parameters: {
          extractor_version: 'recursive-chunks-v1',
          derived_schema_version: 'page-derived-v1',
        },
      });
      expect(await api.listDerivedJobs({ slug })).toHaveLength(1);
      expect(await api.getDerivedIndexState('workspace:default', slug, 'page_chunks')).toMatchObject({
        status: 'pending',
      });

      await api.deletePage(slug);

      expect(await api.listDerivedJobs({ slug })).toHaveLength(0);
      expect(await api.getDerivedIndexState('workspace:default', slug, 'page_chunks')).toBeNull();
    });
  });

  test('updateSlug moves derived jobs and index state to the new slug', async () => {
    await withEngines(async (engine, label) => {
      const api = engine as any;
      const oldSlug = `concepts/${label}-old-derived-slug`;
      const newSlug = `concepts/${label}-new-derived-slug`;
      await api.putPage(oldSlug, {
        type: 'concept',
        title: 'Rename Derived State',
        compiled_truth: 'Canonical page for derived rename cleanup.',
        timeline: '',
        frontmatter: {},
        content_hash: 'hash-1',
      });
      await api.enqueueDerivedJob({
        scope_id: 'workspace:default',
        slug: oldSlug,
        artifact_kind: 'note_manifest',
        target_content_hash: 'hash-1',
        manifest_path: `${oldSlug}.md`,
        derived_parameters: {
          manifest_path: `${oldSlug}.md`,
          extractor_version: 'phase2-structural-v1',
          derived_schema_version: 'page-derived-v1',
        },
      });

      await api.updateSlug(oldSlug, newSlug);

      expect(await api.listDerivedJobs({ slug: oldSlug })).toHaveLength(0);
      expect(await api.getDerivedIndexState('workspace:default', oldSlug, 'note_manifest')).toBeNull();
      const jobs = await api.listDerivedJobs({ slug: newSlug });
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        slug: newSlug,
        artifact_kind: 'note_manifest',
        target_content_hash: 'hash-1',
        manifest_path: `${newSlug}.md`,
        derived_parameters: {
          manifest_path: `${newSlug}.md`,
        },
      });
      expect(await api.getDerivedIndexState('workspace:default', newSlug, 'note_manifest')).toMatchObject({
        status: 'pending',
        target_content_hash: 'hash-1',
      });
    });
  });

  test('updateSlug retargets ready manifest and section storage to the new slug', async () => {
    await withEngines(async (engine, label) => {
      const api = engine as any;
      const oldSlug = `concepts/${label}-ready-derived-old`;
      const newSlug = `concepts/${label}-ready-derived-new`;
      await importFromContent(engine as any, oldSlug, [
        '---',
        'type: concept',
        `title: ${label} Ready Rename`,
        'tags: [rename]',
        '---',
        '# Ready Rename',
        'Body before rename.',
        '',
        '## Section A',
        'Section body.',
      ].join('\n'));

      expect(await api.getNoteManifestEntry(DEFAULT_NOTE_MANIFEST_SCOPE_ID, oldSlug)).toMatchObject({
        slug: oldSlug,
        path: `${oldSlug}.md`,
      });
      expect(await api.listNoteSectionEntries({
        scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
        page_slug: oldSlug,
      })).toHaveLength(2);

      await api.updateSlug(oldSlug, newSlug);

      expect(await api.getNoteManifestEntry(DEFAULT_NOTE_MANIFEST_SCOPE_ID, oldSlug)).toBeNull();
      expect(await api.getNoteManifestEntry(DEFAULT_NOTE_MANIFEST_SCOPE_ID, newSlug)).toMatchObject({
        slug: newSlug,
        path: `${newSlug}.md`,
      });
      expect(await api.listNoteSectionEntries({
        scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
        page_slug: oldSlug,
      })).toHaveLength(0);
      const sections = await api.listNoteSectionEntries({
        scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
        page_slug: newSlug,
      });
      expect(sections).toHaveLength(2);
      for (const section of sections) {
        expect(section.page_path).toBe(`${newSlug}.md`);
        expect(section.section_id.startsWith(`${newSlug}#`)).toBe(true);
        expect(section.parent_section_id === null || section.parent_section_id.startsWith(`${newSlug}#`)).toBe(true);
      }
      expect(await api.getDerivedIndexState(
        DEFAULT_NOTE_MANIFEST_SCOPE_ID,
        newSlug,
        'note_manifest',
      )).toMatchObject({ status: 'ready' });
    });
  });

  test('postgres and pglite page slug mutations lock page rows before derived job tables', () => {
    const postgresSource = readFileSync(join(import.meta.dir, '../src/core/postgres-engine.ts'), 'utf-8');
    const pgliteSource = readFileSync(join(import.meta.dir, '../src/core/pglite-engine.ts'), 'utf-8');

    for (const source of [postgresSource, pgliteSource]) {
      for (const method of ['deletePage', 'updateSlug']) {
        const body = methodBody(source, method);
        const pageLockIndex = body.indexOf('FOR UPDATE');
        const pageTableLockIndex = body.indexOf('LOCK TABLE pages IN SHARE ROW EXCLUSIVE MODE');
        const derivedLockIndex = body.indexOf('LOCK TABLE derived_jobs');
        expect(pageTableLockIndex).toBeGreaterThanOrEqual(0);
        expect(pageLockIndex).toBeGreaterThanOrEqual(0);
        expect(derivedLockIndex).toBeGreaterThanOrEqual(0);
        expect(pageTableLockIndex).toBeLessThan(derivedLockIndex);
        expect(pageLockIndex).toBeLessThan(derivedLockIndex);
      }
    }
  });

  test('enqueueDerivedJob supersedes stale running work before inserting the newer target', async () => {
    await withEngines(async (engine, label) => {
      const api = engine as any;
      const slug = `concepts/${label}-running-derived`;
      const first = await api.enqueueDerivedJob({
        scope_id: 'workspace:default',
        slug,
        artifact_kind: 'page_chunks',
        target_content_hash: 'hash-1',
        manifest_path: `${slug}.md`,
        derived_parameters: {
          extractor_version: 'recursive-chunks-v1',
          derived_schema_version: 'page-derived-v1',
        },
      });

      if (label === 'sqlite') {
        api.database.run(`UPDATE derived_jobs SET status = 'running' WHERE id = ?`, [first.id]);
      } else {
        await api.db.query(`UPDATE derived_jobs SET status = 'running' WHERE id = $1`, [first.id]);
      }

      const newer = await api.enqueueDerivedJob({
        scope_id: 'workspace:default',
        slug,
        artifact_kind: 'page_chunks',
        target_content_hash: 'hash-2',
        manifest_path: `${slug}.md`,
        derived_parameters: {
          extractor_version: 'recursive-chunks-v1',
          derived_schema_version: 'page-derived-v1',
        },
      });

      expect(newer.status).toBe('pending');
      const jobs = await api.listDerivedJobs({
        scope_id: 'workspace:default',
        slug,
        artifact_kind: 'page_chunks',
      });
      expect(jobs.find((job: any) => job.id === first.id)?.status).toBe('superseded');
      expect(jobs.find((job: any) => job.id === newer.id)?.target_content_hash).toBe('hash-2');
    });
  });

  test('stale ready completion does not override a newer pending content hash', async () => {
    await withEngines(async (engine, label) => {
      const api = engine as any;
      const slug = `concepts/${label}-stale-ready`;
      const first = await api.enqueueDerivedJob({
        scope_id: 'workspace:default',
        slug,
        artifact_kind: 'note_manifest',
        target_content_hash: 'hash-1',
        manifest_path: `${slug}.md`,
        derived_parameters: {
          manifest_path: `${slug}.md`,
          extractor_version: 'phase2-structural-v1',
          derived_schema_version: 'page-derived-v1',
        },
      });

      if (label === 'sqlite') {
        api.database.run(`UPDATE derived_jobs SET status = 'running' WHERE id = ?`, [first.id]);
      } else {
        await api.db.query(`UPDATE derived_jobs SET status = 'running' WHERE id = $1`, [first.id]);
      }

      const newer = await api.enqueueDerivedJob({
        scope_id: 'workspace:default',
        slug,
        artifact_kind: 'note_manifest',
        target_content_hash: 'hash-2',
        manifest_path: `${slug}.md`,
        derived_parameters: {
          manifest_path: `${slug}.md`,
          extractor_version: 'phase2-structural-v1',
          derived_schema_version: 'page-derived-v1',
        },
      });

      const completion = await api.markDerivedIndexReady({
        scope_id: 'workspace:default',
        slug,
        artifact_kind: 'note_manifest',
        target_content_hash: 'hash-1',
        indexed_content_hash: 'hash-1',
        manifest_path: `${slug}.md`,
        derived_parameters: {
          manifest_path: `${slug}.md`,
          extractor_version: 'phase2-structural-v1',
          derived_schema_version: 'page-derived-v1',
        },
      });

      expect(completion).toMatchObject({
        status: 'pending',
        target_content_hash: 'hash-2',
        indexed_content_hash: null,
      });
      const jobs = await api.listDerivedJobs({
        scope_id: 'workspace:default',
        slug,
        artifact_kind: 'note_manifest',
      });
      expect(jobs.find((job: any) => job.id === newer.id)?.status).toBe('pending');
    });
  });

  test('stale ready completion does not override a newer ready state after the active job is gone', async () => {
    await withEngines(async (engine, label) => {
      const api = engine as any;
      const slug = `concepts/${label}-late-ready`;
      const first = await api.enqueueDerivedJob({
        scope_id: 'workspace:default',
        slug,
        artifact_kind: 'note_manifest',
        target_content_hash: 'hash-1',
        manifest_path: `${slug}.md`,
        derived_parameters: {
          manifest_path: `${slug}.md`,
          extractor_version: 'phase2-structural-v1',
          derived_schema_version: 'page-derived-v1',
        },
      });

      if (label === 'sqlite') {
        api.database.run(`UPDATE derived_jobs SET status = 'running' WHERE id = ?`, [first.id]);
      } else {
        await api.db.query(`UPDATE derived_jobs SET status = 'running' WHERE id = $1`, [first.id]);
      }

      await api.enqueueDerivedJob({
        scope_id: 'workspace:default',
        slug,
        artifact_kind: 'note_manifest',
        target_content_hash: 'hash-2',
        manifest_path: `${slug}.md`,
        derived_parameters: {
          manifest_path: `${slug}.md`,
          extractor_version: 'phase2-structural-v1',
          derived_schema_version: 'page-derived-v1',
        },
      });
      await api.markDerivedIndexReady({
        scope_id: 'workspace:default',
        slug,
        artifact_kind: 'note_manifest',
        target_content_hash: 'hash-2',
        indexed_content_hash: 'hash-2',
        manifest_path: `${slug}.md`,
        derived_parameters: {
          manifest_path: `${slug}.md`,
          extractor_version: 'phase2-structural-v1',
          derived_schema_version: 'page-derived-v1',
        },
        require_active_job: true,
      });

      const staleCompletion = await api.markDerivedIndexReady({
        scope_id: 'workspace:default',
        slug,
        artifact_kind: 'note_manifest',
        target_content_hash: 'hash-1',
        indexed_content_hash: 'hash-1',
        manifest_path: `${slug}.md`,
        derived_parameters: {
          manifest_path: `${slug}.md`,
          extractor_version: 'phase2-structural-v1',
          derived_schema_version: 'page-derived-v1',
        },
        require_active_job: true,
      });

      expect(staleCompletion).toMatchObject({
        status: 'ready',
        target_content_hash: 'hash-2',
        indexed_content_hash: 'hash-2',
      });
    });
  });

  test('same-hash ready completion is guarded by manifest path target', async () => {
    await withEngines(async (engine, label) => {
      const api = engine as any;
      const slug = `concepts/${label}-same-hash-path`;
      const first = await api.enqueueDerivedJob({
        scope_id: 'workspace:default',
        slug,
        artifact_kind: 'note_sections',
        target_content_hash: 'hash-1',
        manifest_path: 'concepts/old-path.md',
        derived_parameters: {
          manifest_path: 'concepts/old-path.md',
          extractor_version: 'phase2-sections-v1',
          derived_schema_version: 'page-derived-v1',
        },
      });

      if (label === 'sqlite') {
        api.database.run(`UPDATE derived_jobs SET status = 'running' WHERE id = ?`, [first.id]);
      } else {
        await api.db.query(`UPDATE derived_jobs SET status = 'running' WHERE id = $1`, [first.id]);
      }

      const newer = await api.enqueueDerivedJob({
        scope_id: 'workspace:default',
        slug,
        artifact_kind: 'note_sections',
        target_content_hash: 'hash-1',
        manifest_path: 'concepts/new-path.md',
        derived_parameters: {
          manifest_path: 'concepts/new-path.md',
          extractor_version: 'phase2-sections-v1',
          derived_schema_version: 'page-derived-v1',
        },
      });

      const completion = await api.markDerivedIndexReady({
        scope_id: 'workspace:default',
        slug,
        artifact_kind: 'note_sections',
        target_content_hash: 'hash-1',
        indexed_content_hash: 'hash-1',
        manifest_path: 'concepts/old-path.md',
        derived_parameters: {
          manifest_path: 'concepts/old-path.md',
          extractor_version: 'phase2-sections-v1',
          derived_schema_version: 'page-derived-v1',
        },
      });

      expect(completion.status).toBe('pending');
      const jobs = await api.listDerivedJobs({
        scope_id: 'workspace:default',
        slug,
        artifact_kind: 'note_sections',
      });
      expect(jobs.find((job: any) => job.id === newer.id)?.status).toBe('pending');
      expect(jobs.find((job: any) => job.id === newer.id)?.manifest_path).toBe('concepts/new-path.md');
    });
  });

  const postgresDatabaseUrl = process.env.DATABASE_URL;
  if (postgresDatabaseUrl) {
    test('postgres implements the derived job lease, release, retry, and owner contract', async () => {
      const engine = new PostgresEngine();
      const slug = `concepts/postgres-derived-contract-${Date.now()}`;
      try {
        await engine.connect({ engine: 'postgres', database_url: postgresDatabaseUrl });
        await engine.initSchema();
        await engine.enqueueDerivedJob({
          scope_id: 'workspace:default',
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

        const firstClaim = await engine.claimNextDerivedJob({
          lease_owner: 'postgres-worker-a',
          lease_duration_ms: 60_000,
        });
        expect(firstClaim).toMatchObject({
          slug,
          status: 'running',
          attempts: 1,
          lease_owner: 'postgres-worker-a',
        });

        const ignoredFailure = await engine.markDerivedJobFailed({
          id: firstClaim!.id,
          error: 'wrong owner',
          lease_owner: 'postgres-worker-b',
          max_attempts: 1,
        });
        expect(ignoredFailure).toMatchObject({
          status: 'running',
          lease_owner: 'postgres-worker-a',
          last_error: null,
        });

        const ignoredReady = await engine.markDerivedIndexReady({
          scope_id: 'workspace:default',
          slug,
          artifact_kind: 'page_chunks',
          target_content_hash: 'hash-1',
          indexed_content_hash: 'hash-1',
          manifest_path: `${slug}.md`,
          derived_parameters: {
            manifest_path: `${slug}.md`,
            extractor_version: 'recursive-chunks-v1',
            derived_schema_version: 'page-derived-v1',
          },
          lease_owner: 'postgres-worker-b',
          require_active_job: true,
        });
        expect(ignoredReady.status).toBe('pending');

        const ignoredRelease = await engine.releaseDerivedJobLease({
          id: firstClaim!.id,
          lease_owner: 'postgres-worker-b',
        });
        expect(ignoredRelease).toMatchObject({
          status: 'running',
          attempts: 1,
          lease_owner: 'postgres-worker-a',
        });

        await engine.sql`
          UPDATE derived_jobs
          SET lease_expires_at = '2000-01-01T00:00:00.000Z'
          WHERE id = ${firstClaim!.id}
        `;
        const reclaimed = await engine.claimNextDerivedJob({ lease_owner: 'postgres-worker-b' });
        expect(reclaimed).toMatchObject({
          id: firstClaim!.id,
          status: 'running',
          attempts: 2,
          lease_owner: 'postgres-worker-b',
        });

        const released = await engine.releaseDerivedJobLease({
          id: reclaimed!.id,
          lease_owner: 'postgres-worker-b',
        });
        expect(released).toMatchObject({
          status: 'pending',
          attempts: 1,
          lease_owner: null,
        });

        const finalClaim = await engine.claimNextDerivedJob({ lease_owner: 'postgres-worker-b' });
        expect(finalClaim).toMatchObject({
          id: firstClaim!.id,
          status: 'running',
          attempts: 2,
        });
        const failed = await engine.markDerivedJobFailed({
          id: finalClaim!.id,
          error: 'permanent failure',
          lease_owner: 'postgres-worker-b',
          max_attempts: 2,
        });
        expect(failed).toMatchObject({
          status: 'failed',
          attempts: 2,
          last_error: 'permanent failure',
        });
        expect(await engine.getDerivedIndexState('workspace:default', slug, 'page_chunks')).toMatchObject({
          status: 'failed',
          indexed_content_hash: null,
          last_error: 'permanent failure',
        });
      } finally {
        if ((engine as any)._sql) {
          await engine.sql`DELETE FROM derived_jobs WHERE slug = ${slug}`;
          await engine.sql`DELETE FROM derived_index_state WHERE slug = ${slug}`;
        }
        await engine.disconnect().catch(() => undefined);
      }
    });
  } else {
    test.skip('postgres derived job lease contract skipped: DATABASE_URL is not configured', () => {});
  }
});

function methodBody(source: string, methodName: string): string {
  const start = source.indexOf(`async ${methodName}(`);
  if (start < 0) throw new Error(`Missing method ${methodName}`);
  const next = source.indexOf('\n  async ', start + 1);
  return source.slice(start, next < 0 ? undefined : next);
}
