/**
 * GST-2515: a large source's catch-up that a run limit stops every time.
 *   - A pass that committed work before it was stopped no longer counts toward the abandoned streak, so status stops
 *     calling a source that banks work every pass "abandoned". A pass that committed nothing (only a heartbeat) still
 *     counts.
 *   - A read-only mirror carries its database-only pages (file gone upstream, page edited in gbrain) as a counted class
 *     that never blocks the pass, and status never advises `--prefer database`, which would write the mirror.
 *   - A symlink whose target does not exist is skipped instead of held as unreadable; one whose path is a live page's
 *     stays held; an unreadable hold an older pass wrote for a dangling link is released.
 * PGLite always; Postgres when DATABASE_URL is set (managedBrain). Synthetic content only.
 */
import { describe, expect, setSystemTime, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { readPassRow } from '../src/core/persistence/sync-pass-row.ts';
import { readSyncStatus } from '../src/core/persistence/sync-status.ts';
import { writeGitHold } from '../src/core/persistence/sync-holds.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid',
  '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const note = (slug: string, body: string) => `---\ntype: concept\ntitle: ${slug}\n---\n\n${body}\n`;
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
class Killed extends Error {}
const incarnation = async (engine: any) => (await engine.executeRaw("SELECT incarnation::text AS i FROM sources WHERE id='default'"))[0].i as string;
const holdCodes = async (engine: any) => Object.fromEntries((await engine.executeRaw(
  "SELECT completed_keys->0->>'code' AS code, count(*)::int AS n FROM op_checkpoints WHERE op='sync-hold' GROUP BY 1")).map((r: any) => [r.code, r.n]));
const seed = (count: number, databaseUrl: string | undefined) => ({ databaseUrl, setup: ({ root }: { root: string }) => {
  git(root, 'init', '-q'); mkdirSync(join(root, 'keep'), { recursive: true });
  for (let i = 0; i < count; i++) writeFileSync(join(root, 'keep', `k${i}.md`), note(`keep/k${i}`, `Body ${i}.`));
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'init');
} });

/** One sync stopped after `after` admitted batches (`after` 0: before the first). */
async function killedSync(engine: any, after: number) {
  let n = 0;
  installFaultHook(async point => { if (point === 'sync:mid_checkpoint' && ++n > after) throw new Killed('killed'); });
  try { await performManagedSync(engine, OPTS); } catch (e) { if (!(e instanceof Killed) && !String(e).includes('killed')) throw e; } finally { installFaultHook(undefined); }
}

describe.each(testBackends())('GST-2515: a stopped pass that banked work is not abandoned (%s)', backend => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  test('passes stopped after committing pages keep the abandoned streak at 0 and status does not report pass_abandoned', () => managedBrain(async ({ engine, root }) => {
    await performManagedSync(engine, OPTS);
    mkdirSync(join(root, 'new'), { recursive: true });
    for (let i = 0; i < 60; i++) writeFileSync(join(root, 'new', `n${i}.md`), note(`new/n${i}`, `New ${i}.`));
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'upstream adds files');
    const inc = await incarnation(engine);
    const before = Number((await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM pages WHERE slug LIKE 'new/%'"))[0]!.n);
    for (let pass = 0; pass < 3; pass++) await killedSync(engine, 3);
    const banked = Number((await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM pages WHERE slug LIKE 'new/%'"))[0]!.n);
    expect(banked).toBeGreaterThan(before);
    await performManagedSync(engine, { ...OPTS, dryRun: true } as any).catch(() => undefined);
    const row = await readPassRow(engine, 'default', inc);
    expect(row?.value.obligations.abandoned_streak ?? 0).toBe(0);
    const status: any = await readSyncStatus(engine, 'default');
    expect(status.reason).not.toBe('pass_abandoned');
  }, seed(5, databaseUrl)), 600_000);

  test('an open pass reports the entries it settled so far, on the pass heartbeat', () => managedBrain(async ({ engine, root }) => {
    await performManagedSync(engine, OPTS);
    mkdirSync(join(root, 'new'), { recursive: true });
    for (let i = 0; i < 30; i++) writeFileSync(join(root, 'new', `n${i}.md`), note(`new/n${i}`, `New ${i}.`));
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'upstream adds files');
    const inc = await incarnation(engine);
    let commits = 0;
    const progress = (e: { phase?: string }) => { if (e.phase === 'managed_sync.page_committed' && ++commits === 2) setSystemTime(new Date(Date.now() + 60_000)); };
    let n = 0;
    installFaultHook(async point => { if (point === 'sync:mid_checkpoint' && commits >= 4 && ++n > 1) throw new Killed('killed'); });
    try { await performManagedSync(engine, { ...OPTS, onProgress: progress } as any); } catch (e) { if (!String(e).includes('killed')) throw e; } finally { installFaultHook(undefined); setSystemTime(); }
    const t = (await readPassRow(engine, 'default', inc))?.value.telemetry;
    expect(t?.outcome).toBe('open');
    expect(t?.settled).toBeGreaterThan(0);
  }, seed(3, databaseUrl)), 600_000);

  test('passes stopped before committing anything still build the streak', () => managedBrain(async ({ engine, root }) => {
    await performManagedSync(engine, OPTS);
    mkdirSync(join(root, 'new'), { recursive: true });
    for (let i = 0; i < 10; i++) writeFileSync(join(root, 'new', `n${i}.md`), note(`new/n${i}`, `New ${i}.`));
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'upstream adds files');
    const inc = await incarnation(engine);
    for (let pass = 0; pass < 3; pass++) {
      const stop = (e: { phase?: string }) => { if (e.phase === 'managed_sync.round_admit') throw new Killed('killed'); };
      try { await performManagedSync(engine, { ...OPTS, onProgress: stop } as any); } catch (e) { if (!String(e).includes('killed')) throw e; }
    }
    expect(Number((await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM pages WHERE slug LIKE 'new/%'"))[0]!.n)).toBe(0);
    expect((await readPassRow(engine, 'default', inc))?.value.obligations.abandoned_streak).toBe(2);
  }, seed(3, databaseUrl)), 600_000);
});

describe.each(testBackends())('GST-2515: a read-only mirror (%s)', backend => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  test('database-only pages are carried as a counted class and status never advises --prefer database', () => managedBrain(async ({ engine, root }) => {
    await performManagedSync(engine, OPTS);
    await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(
      "UPDATE pages SET compiled_truth=compiled_truth||' edited', knowledge_revision=gen_random_uuid() WHERE source_id='default' AND slug LIKE 'keep/k1%'"), TEST_WRITE_ATTRIBUTION));
    await engine.executeRaw(`UPDATE sources SET config = config || '{"mirror_read_only": true}'::jsonb WHERE id='default'`);
    for (let i = 10; i < 20; i++) rmSync(join(root, 'keep', `k${i}.md`));
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'upstream removes files');
    await performManagedSync(engine, OPTS);
    const second: any = await performManagedSync(engine, OPTS);
    expect(second.carried).toEqual([expect.objectContaining({ class: 'mirror_database_only', count: 10 })]);
    expect(second.carried[0].sample.length).toBeLessThanOrEqual(5);
    expect(JSON.stringify(second)).not.toContain('--prefer database');
    const status: any = await readSyncStatus(engine, 'default');
    expect(JSON.stringify(status)).not.toContain('--prefer database');
    expect(status.carried).toEqual([expect.objectContaining({ class: 'mirror_database_only', count: 10 })]);
    expect(status.reason).not.toBe('held');
    expect(Number((await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM pages WHERE slug LIKE 'keep/k1%' AND deleted_at IS NULL"))[0]!.n)).toBe(11);
  }, seed(25, databaseUrl)), 600_000);
});

describe.each(testBackends())('GST-2515: dangling symlinks (%s)', backend => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  test('a link to nothing is skipped and counted, not held; a dangling link over a live page stays held', () => managedBrain(async ({ engine, root }) => {
    await performManagedSync(engine, OPTS);
    mkdirSync(join(root, 'links'), { recursive: true });
    for (let i = 0; i < 6; i++) symlinkSync(join(root, 'nowhere', `t${i}.md`), join(root, 'links', `l${i}.md`));
    rmSync(join(root, 'keep', 'k0.md'));
    symlinkSync(join(root, 'nowhere', 'k0.md'), join(root, 'keep', 'k0.md'));
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'upstream adds links');
    // The hold an older gbrain wrote for a dangling link (it read the link as an unreadable file).
    const inc = await incarnation(engine);
    await engine.transaction(tx => writeGitHold(tx, { source_id: 'default', incarnation: inc, path: 'links/l0.md', source_path: 'links/l0.md', slug: 'links/l0', page_id: null,
      code: 'file_unreadable', message: 'links/l0.md: unreadable', upstream_version: null, observed_at: new Date(Date.now() - 60_000).toISOString(), run_id: null, mode: 'managed', meta: {} } as any));
    const result: any = await performManagedSync(engine, OPTS);
    expect(result.skipped?.symlink_dangling?.count).toBe(6);
    const held = await engine.executeRaw<{ path: string }>("SELECT completed_keys->0->>'path' AS path FROM op_checkpoints WHERE op='sync-hold'");
    expect(held.map(h => h.path).filter(p => p.startsWith('links/'))).toEqual([]);
    expect(held.map(h => h.path)).toContain('keep/k0.md');
    expect(Number((await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM pages WHERE slug='keep/k0' AND deleted_at IS NULL"))[0]!.n)).toBe(1);
  }, seed(3, databaseUrl)), 600_000);
});
