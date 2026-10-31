import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { runUnindexedFilesPhase } from '../src/core/cycle/unindexed-files.ts';
import { resolveManagedSyncContext } from '../src/core/persistence/sync-discovery.ts';
import { withEnv } from './helpers/with-env.ts';

test('plain managed directories are explicitly inapplicable, while damaged Git roots remain errors', async () => {
  const home = mkdtempSync(join(tmpdir(), 'unindexed-applicability-'));
  const engine = new PGLiteEngine();
  try {
    await withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
      await engine.connect({}); await engine.initSchema();
      const plain = join(home, 'plain'), damaged = join(home, 'damaged');
      mkdirSync(plain); mkdirSync(damaged);
      writeFileSync(join(plain, 'note.md'), '---\ntitle: Example\n---\nExample evidence.\n');
      writeFileSync(join(damaged, '.git'), 'gitdir: /missing-synthetic-repository\n');
      for (const [id, root] of [['plain-example', plain], ['damaged-example', damaged]]) {
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)', [id, root, '{}']);
        // Claim the plain directory first; its later damaged Git marker must
        // never become a not-applicable result.
        if (id === 'damaged-example') renameSync(join(root!, '.git'), join(home, 'retained-invalid-git'));
        await claimWorktree(engine, id!, root!);
        if (id === 'damaged-example') renameSync(join(home, 'retained-invalid-git'), join(root!, '.git'));
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      }
      await expect(resolveManagedSyncContext(engine, { sourceId: 'plain-example', noPull: true })).rejects.toMatchObject({ code: 'not_a_git_repo' });
      const result = await runUnindexedFilesPhase(engine, { dryRun: true });
      expect(result.details.skipped).toContainEqual({ source_id: 'plain-example', reason: 'not_a_git_repo' });
      expect(result.status).toBe('warn');
      expect(result.details.errors).toContainEqual({ source_id: 'damaged-example', code: 'internal' });
      expect(result.details.skipped).not.toContainEqual({ source_id: 'damaged-example', reason: 'not_a_git_repo' });
    });
  } finally {
    await disposePersistenceConsumer(engine); await engine.disconnect();
    const trash = join(homedir(), '.Trash'); mkdirSync(trash, { recursive: true });
    renameSync(home, join(trash, 'unindexed-applicability-' + randomUUID()));
  }
}, 120_000);
