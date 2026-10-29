/**
 * Wave C 1C (G7): git maintenance for strict sources (src/core/git/maintenance.ts, the `git_maintenance` cycle phase,
 * `gbrain git maintenance` and doctor `git_repo_health`).
 *   - a door write finishes in under 5 s while maintenance holds its lock and a repack runs (no writer lock);
 *   - two runs never overlap: the second finds the maintenance lock busy;
 *   - prune never removes an unreachable object younger than the two-week grace, and an aborted publication's loose
 *     objects (hashed, tree and commit written, no ref moved: what the door leaves) are listed by `git fsck
 *     --unreachable` and pruned once past it;
 *   - an old unreachable blob that a writer hashes again (git freshens its mtime) survives a daily run that lands
 *     between the writer's blob write and its tree, commit and ref update, and the published commit passes `git fsck`;
 *   - the cycle skips a repository whose user scheduled git's own maintenance, and doctor says so;
 *   - a hosted source's bare repository is maintained through its linked worktree;
 *   - doctor warns on a failed run with the preview-first fix, and the CLI previews and applies;
 *   - doctor fails with `git_objects_missing` when a blob HEAD needs is deleted from the object store, passes once it is
 *     restored, and reports a connectivity walk past its bound as not checked.
 * Engine-dependent cases run on PGLite and, with DATABASE_URL, on Postgres.
 */
import { describe, expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { Check } from '../src/commands/doctor.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { gitRepoHealthEntry } from '../src/commands/doctor/checks/git-repo-health.ts';
import { runGitMaintenancePhase } from '../src/core/cycle/git-maintenance.ts';
import { runGit } from '../src/commands/git.ts';
import { LOOSE_GROWTH_BYTES, MAINTENANCE_RECORD_NAME, planMaintenance, readMaintenanceRecord, runMaintenance } from '../src/core/git/maintenance.ts';
import { durableGitRepo, git, gitAsync } from './helpers/git-publication.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';
import { runCli } from './helpers/cli-spawn.ts';

const putPage = operations.find(op => op.name === 'put_page')!;
const appendPage = operations.find(op => op.name === 'append_page')!;
const page = (title: string, body: string) => `---\ntype: note\ntitle: ${title}\n---\n\n${body}\n`;
const strict = (engine: BrainEngine, sourceId = 'default') => engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id=$1`, [sourceId]);
const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };
const exists = (repo: string, oid: string) => Bun.spawnSync(['git', '-C', repo, 'cat-file', '-e', oid]).exitCode === 0;
const looseFile = (repo: string, oid: string) => join(repo, '.git', 'objects', oid.slice(0, 2), oid.slice(2));
const age = (path: string, days: number) => { const t = Date.now() / 1000 - days * 86_400; utimesSync(path, t, t); };
const doctor = async (engine: BrainEngine): Promise<Check> => (await gitRepoHealthEntry.run({ engine, progress: { heartbeat() {} } } as unknown as DoctorContext) as Check[])[0]!;

function scratchRepo(): { repo: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-git-maintenance-'));
  const repo = join(dir, 'repo');
  git(dir, 'init', '-q', repo);
  writeFileSync(join(repo, 'a.md'), 'first\n');
  git(repo, 'add', 'a.md');
  git(repo, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'first');
  return { repo, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** What a door publication that stopped before its ref update leaves: a blob, a tree and a commit no ref names. */
function abortedPublication(repo: string, text: string): string[] {
  const blob = Bun.spawnSync(['git', '-C', repo, 'hash-object', '-w', '--stdin'], { stdin: Buffer.from(text) }).stdout.toString().trim();
  const tree = Bun.spawnSync(['git', '-C', repo, 'mktree'], { stdin: Buffer.from(`100644 blob ${blob}\tnotes-aborted.md\n`) }).stdout.toString().trim();
  const commit = Bun.spawnSync(['git', '-C', repo, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit-tree', tree, '-p', 'HEAD', '-m', 'aborted'])
    .stdout.toString().trim();
  for (const oid of [blob, tree, commit]) expect(oid).toMatch(/^[0-9a-f]{40}$/);
  return [blob, tree, commit];
}

describe('git maintenance without a database', () => {
  test('prune keeps unreachable objects younger than the grace and prunes an aborted publication once past it', async () => {
    const { repo, cleanup } = scratchRepo();
    try {
      const young = abortedPublication(repo, 'young aborted publication\n');
      const old = abortedPublication(repo, 'old aborted publication\n');
      for (const oid of old) age(looseFile(repo, oid), 15);
      const unreachable = git(repo, 'fsck', '--unreachable', '--no-reflogs');
      for (const oid of [...young, ...old]) expect(unreachable).toContain(oid);
      const plan = await planMaintenance(repo, { manual: true });
      expect(plan).toMatchObject({ kind: 'daily', trigger: 'manual', would_prune: old.length });
      const record = await runMaintenance(plan);
      expect(record).toMatchObject({ result: 'ok', kind: 'daily', pruned_objects: old.length });
      for (const oid of old) expect(exists(repo, oid)).toBe(false);
      for (const oid of young) expect(exists(repo, oid)).toBe(true);
      expect(record!.after).toMatchObject({ loose_objects: 0 });
      git(repo, 'fsck', '--strict');
      // A second daily run on a young object kept in the cruft pack still keeps it.
      const again = await runMaintenance(await planMaintenance(repo, { manual: true }));
      expect(again).toMatchObject({ result: 'ok' });
      for (const oid of young) expect(exists(repo, oid)).toBe(true);
    } finally { cleanup(); }
  }, 60_000);

  test('a writer that hashes an old unreachable blob again just before a daily run still publishes it intact', async () => {
    const { repo, cleanup } = scratchRepo();
    try {
      const [blob] = abortedPublication(repo, 'republished page\n');
      for (const oid of abortedPublication(repo, 'republished page\n')) age(looseFile(repo, oid), 30);
      const hashAgain = Bun.spawnSync(['git', '-C', repo, 'hash-object', '-w', '--stdin'], { stdin: Buffer.from('republished page\n') });
      expect(hashAgain.stdout.toString().trim()).toBe(blob!);
      expect(Date.now() - Bun.file(looseFile(repo, blob!)).lastModified).toBeLessThan(60_000);
      expect(await runMaintenance(await planMaintenance(repo, { manual: true }))).toMatchObject({ result: 'ok', kind: 'daily' });
      const tree = Bun.spawnSync(['git', '-C', repo, 'mktree'], { stdin: Buffer.from(`100644 blob ${blob}\tnotes-republished.md\n`) }).stdout.toString().trim();
      const commit = git(repo, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit-tree', tree, '-p', 'HEAD', '-m', 'republished').trim();
      git(repo, 'update-ref', 'HEAD', commit);
      for (const oid of [blob!, tree, commit]) expect(exists(repo, oid)).toBe(true);
      git(repo, 'fsck', '--strict');
    } finally { cleanup(); }
  }, 60_000);

  test('a cycle past its deadline or cancelled starts no git step, records the run as failed and prunes nothing', async () => {
    const { repo, cleanup } = scratchRepo();
    try {
      const old = abortedPublication(repo, 'old aborted publication\n');
      for (const oid of old) age(looseFile(repo, oid), 15);
      const now = Date.now();
      const plan = await planMaintenance(repo, { manual: true });
      await expect(runMaintenance(plan, { now: () => now, deadlineAtMs: now })).rejects.toMatchObject({ code: 'git_maintenance_failed' });
      expect(readMaintenanceRecord(plan.common_dir)).toMatchObject({ result: 'failed', error: 'stopped before git prune: the maintenance cycle was past its deadline' });
      const cancelled = new AbortController(); cancelled.abort();
      await expect(runMaintenance(await planMaintenance(repo, { manual: true }), { signal: cancelled.signal })).rejects.toMatchObject({ code: 'git_maintenance_failed' });
      for (const oid of old) expect(exists(repo, oid)).toBe(true);
      expect(await runMaintenance(await planMaintenance(repo, { manual: true }), { deadlineAtMs: Date.now() + 60_000 })).toMatchObject({ result: 'ok', pruned_objects: old.length });
      for (const oid of old) expect(exists(repo, oid)).toBe(false);
    } finally { cleanup(); }
  }, 60_000);

  test('two runs never overlap: the second finds the maintenance lock busy, and the CLI says git_maintenance_busy', async () => {
    const { repo, cleanup } = scratchRepo();
    try {
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      let locked!: () => void;
      const hasLock = new Promise<void>(resolve => { locked = resolve; });
      const first = runMaintenance(await planMaintenance(repo, { manual: true }), { afterLock: async () => { locked(); await held; } });
      await hasLock;
      expect(await runMaintenance(await planMaintenance(repo, { manual: true }))).toBeNull();
      const cli = await runCli(['git', 'maintenance', '--path', repo, '--apply', '--json']);
      expect(cli.exitCode).toBe(1);
      expect(cli.stdout + cli.stderr).toContain('git_maintenance_busy');
      release();
      expect(await first).toMatchObject({ result: 'ok' });
    } finally { cleanup(); }
  }, 60_000);

  test('the automatic plan: daily when due, a repack when loose objects grew past a large publication, none otherwise', async () => {
    const { repo, cleanup } = scratchRepo();
    try {
      const first = await planMaintenance(repo, { manual: false });
      expect(first).toMatchObject({ kind: 'daily', trigger: 'daily' });
      await runMaintenance(first);
      const old = abortedPublication(repo, 'old aborted publication\n');
      for (const oid of old) age(looseFile(repo, oid), 15);
      // Not due: no prune traversal (would_prune stays 0 although an old unreachable object waits for the daily run).
      expect(await planMaintenance(repo, { manual: false })).toMatchObject({ kind: null, trigger: null, steps: [], would_prune: 0 });
      Bun.spawnSync(['git', '-C', repo, 'hash-object', '-w', '--stdin'], { stdin: randomBytes(LOOSE_GROWTH_BYTES + 1024 * 1024) });
      const grown = await planMaintenance(repo, { manual: false });
      expect(grown).toMatchObject({ kind: 'repack', trigger: 'loose_growth' });
      expect(grown.steps.map(step => step[0])).toEqual(['repack', 'prune-packed']);
      const later = Date.now() + 25 * 60 * 60 * 1000;
      expect(await planMaintenance(repo, { manual: false, now: later })).toMatchObject({ kind: 'daily', trigger: 'daily' });
    } finally { cleanup(); }
  }, 120_000);

  test('a repository whose user scheduled git maintenance is never planned automatically', async () => {
    for (const setting of [['maintenance.auto', 'false'], ['maintenance.strategy', 'incremental']]) {
      const { repo, cleanup } = scratchRepo();
      try {
        git(repo, 'config', setting[0]!, setting[1]!);
        expect(await planMaintenance(repo, { manual: false })).toMatchObject({ user_scheduled: setting[0], kind: null });
        expect(await planMaintenance(repo, { manual: true })).toMatchObject({ user_scheduled: setting[0], kind: 'daily' });
      } finally { cleanup(); }
    }
    const { repo, cleanup } = scratchRepo();
    const global = join(mkdtempSync(join(tmpdir(), 'gbrain-git-global-')), 'gitconfig');
    try {
      writeFileSync(global, `[maintenance]\n\trepo = ${repo}\n`);
      await withEnv({ GIT_CONFIG_GLOBAL: global }, async () => {
        expect(await planMaintenance(repo, { manual: false })).toMatchObject({ user_scheduled: 'maintenance.repo', kind: null });
      });
    } finally { cleanup(); rmSync(global, { force: true }); }
  }, 60_000);

  test('gbrain git maintenance previews by default and changes nothing; --apply runs and records', async () => {
    const { repo, cleanup } = scratchRepo();
    try {
      const old = abortedPublication(repo, 'stale\n');
      for (const oid of old) age(looseFile(repo, oid), 20);
      const run = async (args: string[]) => {
        const cli = await runCli(['git', ...args]);
        return { code: cli.exitCode, doc: JSON.parse(cli.stdout.trim().split('\n').pop()!) };
      };
      const preview = await run(['maintenance', '--path', repo, '--json']);
      expect(preview.code).toBe(0);
      expect(preview.doc).toMatchObject({ mode: 'dry_run', kind: 'daily', would_prune: old.length, last: null });
      expect(preview.doc.steps).toEqual(['git prune --expire=2.weeks.ago', 'git repack -d -q --cruft --cruft-expiration=2.weeks.ago --write-midx', 'git prune-packed']);
      for (const oid of old) expect(exists(repo, oid)).toBe(true);
      expect(existsSync(join(repo, '.git', MAINTENANCE_RECORD_NAME))).toBe(false);
      const applied = await run(['maintenance', '--path', repo, '--apply', '--json']);
      expect(applied.code).toBe(0);
      expect(applied.doc).toMatchObject({ mode: 'apply', result: { result: 'ok', pruned_objects: old.length } });
      for (const oid of old) expect(exists(repo, oid)).toBe(false);
      expect(readMaintenanceRecord(join(repo, '.git'))).toMatchObject({ result: 'ok', trigger: 'manual' });
    } finally { cleanup(); }
  }, 60_000);
});

for (const backend of testBackends()) describe(`[${backend}] git maintenance on strict sources`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test('a 10 KB append through the door finishes in under 5 s while maintenance holds its lock and a repack runs', () => managedBrain(async ({ engine, ctx, root }) => {
    await strict(engine);
    const put = (slug: string, content: string) => putPage.handler(ctx, { slug, content, request_id: randomUUID(), wait_ms: 30_000 }) as Promise<Record<string, any>>;
    expect(await put('notes/large', page('Large', 'line of a long page\n'.repeat(60_000)))).toMatchObject({ state: 'committed' });
    for (let i = 0; i < 5; i++) expect(await put(`notes/other-${i}`, page(`Other ${i}`, `Body ${i}.`))).toMatchObject({ state: 'committed' });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let locked!: () => void;
    const hasLock = new Promise<void>(resolve => { locked = resolve; });
    const maintenance = runMaintenance(await planMaintenance(root, { manual: true }), { afterLock: async () => { locked(); await held; } });
    await hasLock;
    const repack = gitAsync(root, 'repack', '-a', '-d', '-f', '-q');
    const started = performance.now();
    const appended = await appendPage.handler(ctx, { slug: 'notes/large', text: 'tail '.repeat(2048), request_id: randomUUID() }) as Record<string, any>;
    const ms = performance.now() - started;
    expect(appended).toMatchObject({ receipt: { state: 'committed', persistence: { git_state: 'committed' } } });
    expect(ms).toBeLessThan(5000);
    await repack;
    release();
    expect(await maintenance).toMatchObject({ result: 'ok', kind: 'daily' });
    expect(git(root, 'show', 'HEAD:notes/large.md')).toContain('tail tail');
    git(root, 'fsck', '--strict');
    expect(git(root, 'status', '--porcelain', '--', 'notes')).toBe('');
  }, { databaseUrl, setup }), 180_000);

  test('the cycle phase maintains strict sources, skips user-scheduled ones, and doctor reports both', () => managedBrain(async ({ engine, root }) => {
    await strict(engine);
    const dryRun = await runGitMaintenancePhase(engine, { dryRun: true });
    expect(dryRun.details).toMatchObject({ mode: 'dry_run', sources: [{ source_id: 'default', kind: 'daily' }] });
    expect(readMaintenanceRecord(join(root, '.git'))).toBeNull();
    expect(await runGitMaintenancePhase(engine, { dryRun: false })).toMatchObject({ status: 'ok', details: { sources: [{ source_id: 'default', kind: 'daily', trigger: 'daily' }] } });
    expect(readMaintenanceRecord(join(root, '.git'))).toMatchObject({ result: 'ok', trigger: 'daily' });
    expect(await runGitMaintenancePhase(engine, { dryRun: false })).toMatchObject({ details: { sources: [], skipped: [{ source_id: 'default', reason: 'not_due' }] } });
    expect(await doctor(engine)).toMatchObject({ status: 'ok', details: { maintenance: 'auto', sources: [{ source_id: 'default', user_scheduled: null, last_run: { result: 'ok' } }] } });
    git(root, 'config', 'maintenance.strategy', 'incremental');
    expect(await runGitMaintenancePhase(engine, { dryRun: false, now: () => Date.now() + 2 * 86_400_000 }))
      .toMatchObject({ details: { sources: [], skipped: [{ source_id: 'default', reason: 'user_scheduled' }] } });
    const scheduled = await doctor(engine);
    expect(scheduled.status).toBe('ok');
    expect(scheduled.message).toContain("the user scheduled git's own maintenance (maintenance.strategy), so gbrain skips it");
    await engine.setConfig('git.maintenance', 'off');
    expect(await runGitMaintenancePhase(engine, { dryRun: false })).toMatchObject({ status: 'skipped', details: { reason: 'disabled' } });
  }, { databaseUrl, setup }), 120_000);

  test('doctor warns on a failed run with a preview-first fix that names the source', () => managedBrain(async ({ engine, root }) => {
    await strict(engine);
    writeFileSync(join(root, '.git', MAINTENANCE_RECORD_NAME), JSON.stringify({ at: '2026-10-01T00:00:00.000Z', kind: 'daily', trigger: 'daily', result: 'failed',
      error: 'fatal: example failure', before: { loose_objects: 0, loose_bytes: 0, packs: 0, packed_bytes: 0, garbage: 0 }, pruned_objects: 0, daily_at: null }));
    const check = await doctor(engine);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('failed: fatal: example failure');
    expect(check.fix).toMatchObject({ argv: ['gbrain', 'git', 'maintenance', '--source', 'default', '--apply'], actor: 'agent',
      preview_argv: ['gbrain', 'git', 'maintenance', '--source', 'default', '--dry-run', '--json'], verify: { argv: ['gbrain', 'doctor', '--only', 'git_repo_health', '--json'] } });
    const out: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => { out.push(args.map(String).join(' ')); };
    try { expect(await runGit(['maintenance', '--source', 'default', '--apply'], async () => engine)).toBe(0); } finally { console.log = log; }
    expect(out.join('\n')).toMatch(/^maintained \S+: loose .* pruned$/);
    expect(readMaintenanceRecord(join(root, '.git'))).toMatchObject({ result: 'ok', trigger: 'manual' });
    expect(await doctor(engine)).toMatchObject({ status: 'ok' });
  }, { databaseUrl, setup }), 120_000);

  test('doctor fails with git_objects_missing when a blob HEAD needs is gone, passes once it is restored, and reports an unfinished walk as not checked', () => managedBrain(async ({ engine, root }) => {
    await strict(engine);
    writeFileSync(join(root, 'notes-kept.md'), page('Kept', 'A page whose blob goes missing.'));
    git(root, 'add', 'notes-kept.md');
    git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'kept');
    const blob = git(root, 'rev-parse', 'HEAD:notes-kept.md').trim();
    const path = looseFile(root, blob);
    const bytes = readFileSync(path);
    expect(await doctor(engine)).toMatchObject({ status: 'ok', details: { sources: [{ source_id: 'default', connectivity: { state: 'ok' } }] } });
    rmSync(path);
    const broken = await doctor(engine);
    expect(broken).toMatchObject({ status: 'fail', details: { code: 'git_objects_missing', missing: [{ source_id: 'default', count: 1, sample: [blob] }] },
      fix: { actor: 'user', docs: 'docs/guides/shared-checkout-git.md#missing-git-objects', verify: { argv: ['gbrain', 'doctor', '--only', 'git_repo_health', '--json'] } } });
    expect(broken.message).toContain(`default lacks 1 object(s) its history needs (${blob})`);
    writeFileSync(path, bytes);
    expect(await doctor(engine)).toMatchObject({ status: 'ok', details: { sources: [{ connectivity: { state: 'ok' } }] } });
    const unbounded = await withEnv({ GBRAIN_DOCTOR_GIT_FSCK_TIMEOUT_MS: '1' }, () => { rmSync(path); return doctor(engine); });
    expect(unbounded).toMatchObject({ status: 'ok', details: { sources: [{ connectivity: { state: 'not_checked' } }] } });
    expect(unbounded.message).toContain('default: connectivity not checked (');
    writeFileSync(path, bytes);
  }, { databaseUrl, setup }), 120_000);

  test('a hosted source keeps its objects in a bare repository, which the phase maintains through the linked worktree', () => managedBrain(async ({ engine }) => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-hosted-maintenance-'));
    try {
      const bare = join(dir, 'source-a.git');
      const worktree = join(dir, 'worktree');
      git(dir, 'init', '-q', '--bare', '-b', 'main', bare);
      const seed = join(dir, 'seed');
      git(dir, 'init', '-q', '-b', 'main', seed);
      writeFileSync(join(seed, 'a.md'), 'hosted\n');
      git(seed, 'add', 'a.md');
      git(seed, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'seed');
      git(seed, 'push', '-q', bare, 'main');
      git(bare, 'worktree', 'add', '-q', worktree, 'main');
      const old = abortedPublication(worktree, 'hosted aborted publication\n');
      for (const oid of old) age(join(bare, 'objects', oid.slice(0, 2), oid.slice(2)), 15);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw(`INSERT INTO sources(id, name, local_path, config) VALUES('source-a', 'source-a', $1, '{"canonical":"git"}'::jsonb)`, [worktree]);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      const result = await runGitMaintenancePhase(engine, { dryRun: false });
      expect(result.details).toMatchObject({ sources: expect.arrayContaining([expect.objectContaining({ source_id: 'source-a', kind: 'daily', pruned_objects: old.length })]) });
      expect(readMaintenanceRecord(bare)).toMatchObject({ result: 'ok', pruned_objects: old.length });
      for (const oid of old) expect(exists(bare, oid)).toBe(false);
      expect(readFileSync(join(worktree, 'a.md'), 'utf8')).toBe('hosted\n');
      git(bare, 'fsck', '--strict');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, { databaseUrl, setup }), 120_000);
});
