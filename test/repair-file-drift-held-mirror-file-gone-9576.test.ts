/**
 * #9576: a held `file_gone` page of a stale mirror page (`mirror_read_only`, no recorded file) reads its missing file as
 * `database_only` in liveFileDrift. The held side check must treat that as gone, not classify the page `side_changed`.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { RECOVERY_VERSION } from '../src/core/markdown.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { writeGitHold } from '../src/core/persistence/sync-holds.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import { resolveRepairScope } from '../src/core/repair/core.ts';
import { withEnv } from './helpers/with-env.ts';

const logger = { info() {}, warn() {}, error() {} };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid',
  '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let engine: BrainEngine;
beforeAll(async () => {
  const pglite = new PGLiteEngine();
  await pglite.connect({}); await pglite.initSchema(); engine = pglite;
}, 120_000);
afterAll(async () => {
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
});

test('a held file_gone stale-mirror page is not classified side_changed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-9576-'));
  const root = join(dir, 'brain'); mkdirSync(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  const sourceId = `mirror9576-${randomUUID().slice(0, 8)}`;
  try {
    await withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
      await engine.setConfig('sync.write_through', 'true');
      await claimWorktree(engine, sourceId, root);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [sourceId]);
      const ctx = { engine, sourceId, remote: false, config: { engine: engine.kind, embedding_disabled: true } as never, dryRun: false, logger } as OperationContext;
      const slug = 'notes/gone';
      await submitPageMutation(ctx, { operation: 'put_page', params: { slug, content: `---\ntype: note\ntitle: ${slug}\n---\nThe page.\n`, request_id: randomUUID() } });
      git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'page');
      git(root, 'rm', '-q', '--', `${slug}.md`); git(root, 'commit', '-q', '-m', 'remove');
      const live = (await engine.readPageSnapshot(slug, { sourceId, includeDeleted: true }))!;
      // The page was imported while the source was a read-only mirror: stamped, no recorded file.
      await engine.executeRaw(`UPDATE pages SET database_only_reason='mirror_read_only', source_path=NULL WHERE source_id=$1 AND slug=$2`, [sourceId, slug]);
      await engine.transaction(tx => writeGitHold(tx, { source_id: sourceId, incarnation: source!.incarnation, path: `${slug}.md`, source_path: `${slug}.md`, slug,
        page_id: Number(live.page.id), code: 'file_drift', message: 'held: file drift (deleted file_gone)', upstream_version: null,
        observed_at: new Date().toISOString(), run_id: null, mode: 'managed',
        meta: { recovery_version: RECOVERY_VERSION, side: 'deleted', state: 'file_gone', page_revision: live.revision } }));
      const result = await (await repairRunner(engine, { apply: false, logger })).run('file-drift', await resolveRepairScope(engine, sourceId),
        { explicit: true, sourceFlag: sourceId, held: true, prefer: 'database', side: 'deleted', state: 'file_gone' });
      expect(JSON.stringify(result)).not.toContain('side_changed');
    });
  } finally {
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw('UPDATE sources SET archived=true WHERE id=$1', [sourceId]);
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);
