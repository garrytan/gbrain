import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { boundedDiagnostic, ownerDatabaseDiagnostic, receiptDiagnostic, retentionMetadata, soakFailureDiagnostic } from '../scripts/persistence/failure-diagnostics.ts';
import { runValidation } from '../scripts/persistence/validate.ts';

describe('persistence failure evidence', () => {
  const directories: string[] = [];
  afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
  const temporary = () => { const directory = mkdtempSync(join(tmpdir(), 'gbrain-diagnostic-test-')); directories.push(directory); return directory; };

  test('receipt diagnostics omit intent, credentials, paths and free-form errors', () => {
    const id = randomUUID(); const now = new Date();
    const row = { id, request_id: id, state: 'recovering' as const, blocked_reason: 'recovery_required', error_code: '55P03',
      sequence: '42', created_at: now, updated_at: now, publication_started: true,
      intent: { content: 'private body', database_url: 'postgres://private:secret@example.test/db' },
      error_message: 'private error /private/path', recovery: { version: 1 as const, path: '/private/path', root: '/private',
        before: 'private body', beforeHash: null, afterHash: null, mode: null, ownerEpoch: '1', attempt: id } };
    const diagnostic = receiptDiagnostic(row);
    expect(diagnostic).toMatchObject({ id, request_id: id, state: 'recovering', sequence: '42', error_code: '55P03',
      blocked_reason: 'recovery_required', has_recovery: true, publication_started: true, created_at: now.toISOString() });
    expect(JSON.stringify(diagnostic)).not.toMatch(/private|secret|example\.test/);
    expect(receiptDiagnostic({ error_code: 'postgres://secret', blocked_reason: '/private/path' })).toMatchObject({ error_code: null, blocked_reason: null });
    expect(soakFailureDiagnostic(1, 20, Array.from({ length: 8 }, (_, index) => ({ requestId: id, index,
      startedAt: performance.now(), receipt: null }))).active).toHaveLength(4);
  });

  test('a stalled or rejected diagnostic is bounded and cannot replace the original error', async () => {
    const original = new Error('original receipt deadline');
    const start = performance.now();
    const result = await boundedDiagnostic(() => new Promise<never>(() => {}), 20);
    expect(result).toEqual({ status: 'timeout' });
    expect(performance.now() - start).toBeLessThan(1_000);
    expect(await boundedDiagnostic(async () => { throw Object.assign(new Error('postgres://private:secret'), { code: 'ECONNRESET' }); }))
      .toEqual({ status: 'error', code: 'ECONNRESET' });
    const failing = async () => { try { throw original; } catch (error) { await boundedDiagnostic(async () => { throw new Error('secondary'); }); throw error; } };
    await expect(failing()).rejects.toBe(original);
  });

  test('failed validation retains private fixtures with cleanup metadata and its original failure', async () => {
    const manifestPath = join(temporary(), 'manifest.json');
    await expect(runValidation({ engine: 'postgres', crashes: false, schedules: 0, operations: 0, manifest: manifestPath }))
      .rejects.toThrow('Postgres validation requires an explicit test DATABASE_URL');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const retainedPath = `${manifestPath}.retained.json`;
    const retained = JSON.parse(readFileSync(retainedPath, 'utf8')); directories.push(retained.scratch_root);
    expect(manifest).toMatchObject({ status: 'failed', full_gate: false, failure_artifacts: { retained: true } });
    expect(existsSync(retained.scratch_root)).toBe(true);
    expect(statSync(retainedPath).mode & 0o777).toBe(0o600);
    expect(retained.cleanup.remove_scratch_argv).toEqual(['rm', '-rf', '--', retained.scratch_root]);
    expect(JSON.stringify(manifest)).not.toContain(retained.scratch_root);
    const name = `gbrain_persistence_test_${randomUUID().replaceAll('-', '')}`;
    const cleanup = retentionMetadata(retained.scratch_root, [name]);
    expect(cleanup.cleanup.database_commands[0]).toContain('psql "$DATABASE_URL"');
    expect(cleanup.cleanup.database_commands[0]).toContain(name);
    expect(() => retentionMetadata(retained.scratch_root, ['unrelated_database'])).toThrow('Invalid retained fixture');
  });

  test('report write failure does not mask the original validation error', async () => {
    const manifestPath = join(temporary(), 'directory'); mkdirSync(manifestPath);
    await expect(runValidation({ engine: 'postgres', crashes: false, schedules: 0, operations: 0, manifest: manifestPath }))
      .rejects.toThrow('Postgres validation requires an explicit test DATABASE_URL');
    const retained = JSON.parse(readFileSync(`${manifestPath}.retained.json`, 'utf8')); directories.push(retained.scratch_root);
    expect(existsSync(retained.scratch_root)).toBe(true);
  });

  test('successful small runs preserve full-gate requirements and need no retention metadata', async () => {
    const manifestPath = join(temporary(), 'manifest.json');
    expect(await runValidation({ engine: 'pglite', crashes: false, schedules: 0, operations: 0, manifest: manifestPath }))
      .toMatchObject({ status: 'passed', full_gate: false });
    expect(existsSync(`${manifestPath}.retained.json`)).toBe(false);
  });
});

describe('owner diagnostics query', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
  afterAll(async () => { await engine?.disconnect(); });
  test('returns bounded queue and owner metadata from the actual schema', async () => {
    const rootId = randomUUID(); const hostId = randomUUID();
    await engine.executeRaw('INSERT INTO persistence_worktrees(id,owner_host_id,owner_epoch) VALUES($1,$2,7)', [rootId, hostId]);
    const summary = await ownerDatabaseDiagnostic(engine);
    expect(summary.queue).toEqual([]);
    expect(summary.roots).toContainEqual({ id: rootId, owner_host_id: hostId, owner_epoch: '7', state: 'active', heartbeat_at: null, pending: '0' });
    expect(JSON.stringify(summary)).not.toMatch(/local_path|coordination_path|credential|authority/);
  });
});
