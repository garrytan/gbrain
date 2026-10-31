/**
 * #7087: a managed `gbrain sync --dry-run` returned the cursor's committed counts (zero before a run) and printed
 * nothing, so the preview said nothing would change while files differed. Its counts are now the changes the run
 * would publish (an idle preview after a run used to repeat that run's counts), and the CLI prints them.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { printSyncResult } from '../src/commands/sync/report.ts';
import type { SyncResult } from '../src/commands/sync.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(realpathSync.native(tmpdir()), 'gbrain-7087-'));
let engine: PGLiteEngine;
function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function commit(root: string, message: string): void {
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message);
}
const page = (title: string, body: string) => `---\ntype: note\ntitle: ${title}\n---\n${body}\n`;
function printed(result: SyncResult): string {
  let out = '';
  printSyncResult(result, { write: (chunk: string) => { out += chunk; return true; } } as unknown as NodeJS.WriteStream);
  return out;
}

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => {
  await withEnv({ GBRAIN_HOME: home }, () => disposePersistenceConsumer(engine));
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
});

// Value: protects=a managed sync dry run previews the adds, edits, deletes and renames a real run would publish (#7087);
// fails_when=managedDryRun reports the cursor's committed counts (zero) or the CLI prints nothing for a managed dry run;
// why_new=the dry-run tests only checked would_hold and would_normalize; seam=performManagedSync({ dryRun }) + printSyncResult;
// no_claim=per-path listing (counts only); a --full dry run counts every existing file under modify (the full run re-reads
// each); the classic unmanaged dry run, which already lists paths.
test('a managed dry run counts what the run would publish and writes nothing', async () =>
  withEnv({ GBRAIN_HOME: home }, async () => {
    const sourceId = `d${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const root = join(home, sourceId);
    mkdirSync(join(root, 'notes'), { recursive: true });
    git(root, 'init', '-q');
    for (const name of ['keep', 'edit', 'gone', 'old']) writeFileSync(join(root, 'notes', `${name}.md`), page(name, `The ${name} page body.`));
    commit(root, 'initial');
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [sourceId, root]);
    await claimWorktree(engine, sourceId, root);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const opts = { sourceId, noPull: true, noEmbed: true, noExtract: true };

    const first = await performManagedSync(engine, { ...opts, dryRun: true });
    expect(first).toMatchObject({ status: 'dry_run', added: 4, modified: 0, deleted: 0, renamed: 0 });
    expect(printed(first)).toContain('would add 4, modify 0, soft-delete 0, rename 0');
    expect((await performManagedSync(engine, opts)).status).toBe('first_sync');

    writeFileSync(join(root, 'notes', 'edit.md'), page('edit', 'The edit page body, changed.'));
    writeFileSync(join(root, 'notes', 'new.md'), page('new', 'A new page.'));
    git(root, 'rm', '-q', 'notes/gone.md');
    git(root, 'mv', 'notes/old.md', 'notes/moved.md');
    commit(root, 'changes');
    const preview = await performManagedSync(engine, { ...opts, dryRun: true });
    expect(preview).toMatchObject({ status: 'dry_run', added: 1, modified: 1, deleted: 1, renamed: 1 });
    expect(printed(preview)).toContain('would add 1, modify 1, soft-delete 1, rename 1');
    const [live] = await engine.executeRaw<{ n: number }>('SELECT COUNT(*)::int AS n FROM pages WHERE source_id=$1 AND deleted_at IS NULL', [sourceId]);
    expect(live!.n).toBe(4);

    const synced = await performManagedSync(engine, opts);
    expect(synced).toMatchObject({ status: 'synced', added: 1, modified: 1, deleted: 1, renamed: 1 });
    const idle = await performManagedSync(engine, { ...opts, dryRun: true });
    expect(idle).toMatchObject({ status: 'dry_run', added: 0, modified: 0, deleted: 0, renamed: 0 });
    expect(printed(idle)).toContain('(no syncable changes)');
  }), 120_000);
