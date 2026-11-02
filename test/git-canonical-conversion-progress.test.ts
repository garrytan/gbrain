/**
 * #7644: a conversion apply says where it stands. \`applyGitConversion\` reports each phase in order with the door groups it
 * committed and the items the phase went through; the CLI prints them on stderr (a JSON line with --json), and a SIGTERM
 * during the strict pass prints a partial report on stdout naming the phase, the groups committed, the paths scanned and
 * the source's canonical state, then exits 143. GBRAIN_MEMORY_TRACE adds a periodic memory line.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { applyGitConversion, CONVERSION_GROUP_MAX, CONVERSION_PHASES, planGitConversion, type ConversionProgress } from '../src/core/persistence/git-conversion.ts';
import { runSourcesCanonical } from '../src/commands/sources-canonical.ts';
import { _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import { memoryTraceIntervalMs, memoryTraceLine, startMemoryTrace } from '../src/core/memory-trace.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const REPO = join(import.meta.dir, '..');
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const note = (slug: string, body: string) => '---\ntype: concept\ntitle: ' + slug + '\n---\n\n' + body + '\n';
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const BULK = CONVERSION_GROUP_MAX + 1;
const bulkSetup = ({ root }: { root: string }) => {
  mkdirSync(join(root, 'bulk'), { recursive: true }); git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Example Writer'); git(root, 'config', 'user.email', 'writer@example.invalid');
  for (let i = 0; i < BULK; i++) writeFileSync(join(root, 'bulk/p' + String(i).padStart(3, '0') + '.md'), note('bulk/p' + i, 'Committed body ' + i + '.'));
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'bulk');
};
/** bulkSetup with git durability's shape: a bare tracking remote beside the checkout that holds the seeded commit. */
const remoteOf = (root: string) => join(dirname(root), 'remote.git');
const durableSetup = (brain: { root: string }) => {
  bulkSetup(brain);
  execFileSync('git', ['init', '-q', '--bare', remoteOf(brain.root)]);
  git(brain.root, 'remote', 'add', 'origin', remoteOf(brain.root));
  git(brain.root, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  git(brain.root, 'branch', '--set-upstream-to=origin/main');
};
const enableDurability = (engine: Parameters<Parameters<typeof managedBrain>[0]>[0]['engine']) =>
  engine.executeRaw("UPDATE persistence_host_bindings SET git_durability='enabled'");
const remoteHead = (root: string) => execFileSync('git', ['-C', remoteOf(root), 'rev-parse', 'refs/heads/main'], { encoding: 'utf8' }).trim();
/** Every bulk page edited in the database alone: the plan adopts them in two door groups. */
const editBulk = (engine: Parameters<Parameters<typeof managedBrain>[0]>[0]['engine']) => engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(
  "UPDATE pages SET compiled_truth=compiled_truth || ' Edited in the database.', knowledge_revision=gen_random_uuid(), revision_write_request_id=NULL WHERE source_id='default' AND slug LIKE 'bulk/%'"), TEST_WRITE_ATTRIBUTION));

for (const backend of testBackends()) describe('[' + backend + '] #7644: a conversion apply reports its progress', () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test('the apply reports every phase in order, the door groups as they commit, and each strict pass round', () => managedBrain(async ({ engine }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await editBulk(engine);
    const { preview } = await planGitConversion(engine, 'default');
    const seen: ConversionProgress[] = [];
    expect(await applyGitConversion(engine, 'default', preview.preview_hash, { noEmbed: true, noExtract: true, onProgress: progress => seen.push(progress) }))
      .toMatchObject({ status: 'converted', committed: { groups: 2, pages: BULK } });
    expect([...new Set(seen.map(progress => progress.phase))]).toEqual([...CONVERSION_PHASES]);
    // Phases only move forward.
    expect(seen.map(progress => CONVERSION_PHASES.indexOf(progress.phase))).toEqual(seen.map(progress => CONVERSION_PHASES.indexOf(progress.phase)).sort((a, b) => a - b));
    expect(seen.filter(progress => progress.phase === 'adopt').map(({ scanned, total, groups_committed }) => [scanned, total, groups_committed]))
      .toEqual([[0, BULK, 0], [CONVERSION_GROUP_MAX, BULK, 1], [BULK, BULK, 2]]);
    for (const phase of ['strict_pass_1', 'strict_pass_2'] as const) {
      const pass = seen.filter(progress => progress.phase === phase);
      expect(pass.every(progress => progress.groups_committed === 2 && progress.scanned <= progress.total)).toBe(true);
      // #7866: the total is the planned paths, the same on every event of the pass.
      expect(pass.some(progress => progress.round === 1 && progress.total >= BULK)).toBe(true);
      expect(new Set(pass.map(progress => progress.total)).size).toBe(1);
    }
    // The first pass settles its candidates, every adopted page, in one batch; the second admits every page, now current, in place, so its round has no candidate.
    expect(seen.some(progress => progress.phase === 'strict_pass_1' && progress.round === 1 && progress.candidates === BULK && progress.batch === 1 && progress.batches === 1 && progress.scanned >= BULK)).toBe(true);
    expect(seen.filter(progress => progress.phase === 'strict_pass_2').every(progress => progress.scanned === 0 && (progress.candidates ?? 0) === 0)).toBe(true);
    expect(seen.some(progress => progress.phase === 'strict_pass_2' && progress.round === 1)).toBe(true);
  }, { databaseUrl, setup: bulkSetup }), 300_000);

  test('the CLI prints a progress line on stderr at each phase, and a JSON line with --json', () => managedBrain(async ({ engine }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await editBulk(engine);
    const { preview } = await planGitConversion(engine, 'default');
    const err: string[] = [], out: string[] = [];
    const write = process.stderr.write, log = console.log, priorExitCode = process.exitCode;
    process.stderr.write = ((chunk: string | Uint8Array) => { err.push(String(chunk)); return true; }) as typeof process.stderr.write;
    console.log = (line: unknown) => { out.push(String(line)); };
    try { await runSourcesCanonical(engine, ['default', '--to', 'git', '--apply', '--expect', preview.preview_hash, '--no-embed', '--no-extract', '--json']); }
    finally { process.stderr.write = write; console.log = log; _resetCliExitVerdictForTests(); process.exitCode = priorExitCode ?? 0; }
    expect(JSON.parse(out.at(-1)!)).toMatchObject({ status: 'converted' });
    const lines = err.join('').split('\n').filter(line => line.includes('"conversion_progress"')).map(line => JSON.parse(line));
    // A line at each change of phase; a phase longer than PROGRESS_EVERY_MS repeats its line on the interval.
    expect(lines.map(line => line.phase).filter((phase, i, all) => phase !== all[i - 1])).toEqual([...CONVERSION_PHASES]);
    expect(lines.at(-1)).toMatchObject({ event: 'conversion_progress', source_id: 'default', phase: 'strict_pass_2', groups_committed: 2 });
  }, { databaseUrl, setup: bulkSetup }), 300_000);

  test('with durability on, the apply pushes its door commits: the remote branch ends at HEAD', () => managedBrain(async ({ engine, root }) => {
    await enableDurability(engine);
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await editBulk(engine);
    const seeded = remoteHead(root);
    const { preview } = await planGitConversion(engine, 'default');
    const seen: ConversionProgress[] = [];
    const result = await applyGitConversion(engine, 'default', preview.preview_hash, { noEmbed: true, noExtract: true, onProgress: progress => seen.push(progress) });
    expect(result).toMatchObject({ status: 'converted', committed: { groups: 2 }, push: { state: 'pushed' } });
    expect(remoteHead(root)).toBe(git(root, 'rev-parse', 'HEAD'));
    expect(remoteHead(root)).not.toBe(seeded);
    // The push lands before the strict pass, so an apply stopped there has already sent its door commits.
    expect(seen.find(progress => progress.phase === 'strict_pass_1')?.push).toEqual({ state: 'pushed' });
  }, { databaseUrl, setup: durableSetup }), 300_000);

  test('a remote that rejects the push still converts, and the receipt reports the push pending', () => managedBrain(async ({ engine, root }) => {
    await enableDurability(engine);
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await editBulk(engine);
    const seeded = remoteHead(root);
    writeFileSync(join(remoteOf(root), 'hooks', 'pre-receive'), '#!/bin/sh\necho "pushes are closed" >&2\nexit 1\n', { mode: 0o755 });
    const { preview } = await planGitConversion(engine, 'default');
    const result = await applyGitConversion(engine, 'default', preview.preview_hash, { noEmbed: true, noExtract: true });
    expect(result).toMatchObject({ status: 'converted', committed: { groups: 2 }, push: { state: 'pending', code: 'git_push_unavailable' } });
    expect(result.push.notice).toContain('committed locally');
    expect(remoteHead(root)).toBe(seeded);
    expect(git(root, 'rev-list', '--count', '@{upstream}..HEAD')).toBe('2');
  }, { databaseUrl, setup: durableSetup }), 300_000);
});

describe('#7644: SIGTERM during the strict pass', () => {
  const work = mkdtempSync(join(tmpdir(), 'gbrain-conversion-sigterm-'));
  afterAll(() => rmSync(work, { recursive: true, force: true }));
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env)
    .filter(([key, value]) => value !== undefined && !['DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_SOURCE', 'GBRAIN_BRAIN_ID', 'GBRAIN_MEMORY_TRACE'].includes(key))) as Record<string, string>;
  env.GBRAIN_HOME = join(work, 'home');
  const cli = (...args: string[]) => {
    const result = spawnSync(process.execPath, ['--no-env-file', join(REPO, 'src', 'cli.ts'), ...args], { cwd: REPO, env, encoding: 'utf8', timeout: 180_000 });
    if (result.status !== 0) throw new Error('gbrain ' + args.join(' ') + ' exited ' + result.status + ':\n' + result.stdout + result.stderr);
    return result.stdout;
  };

  test('prints a partial report naming the phase, groups, paths scanned and canonical state, then exits 143', async () => {
    const checkout = join(work, 'notes');
    mkdirSync(join(checkout, 'bulk'), { recursive: true });
    git(checkout, 'init', '-q'); git(checkout, 'config', 'user.name', 'Example Writer'); git(checkout, 'config', 'user.email', 'writer@example.invalid');
    for (let i = 0; i < 300; i++) writeFileSync(join(checkout, 'bulk/p' + i + '.md'), note('bulk/p' + i, 'Committed body ' + i + '.'));
    git(checkout, 'add', '-A'); git(checkout, 'commit', '-qm', 'bulk');
    cli('init', '--pglite', '--no-embedding');
    cli('config', 'set', 'self_upgrade.mode', 'off');
    cli('sources', 'add', 'notes', '--path', checkout);
    cli('sync', '--source', 'notes', '--no-pull', '--no-embed');
    const hash = JSON.parse(cli('sources', 'canonical', 'notes', '--to', 'git', '--dry-run', '--json').trim().split('\n').at(-1)!).preview_hash as string;

    const child = Bun.spawn([process.execPath, '--no-env-file', join(REPO, 'src', 'cli.ts'), 'sources', 'canonical', 'notes', '--to', 'git', '--apply', '--expect', hash, '--no-embed', '--json'],
      { cwd: REPO, env, stdout: 'pipe', stderr: 'pipe' });
    let err = '', killed = false;
    const reading = (async () => {
      for await (const chunk of child.stderr) {
        err += new TextDecoder().decode(chunk);
        if (!killed && err.includes('"phase":"strict_pass_1"')) { killed = true; child.kill('SIGTERM'); }
      }
    })();
    const stdout = await new Response(child.stdout).text();
    const code = await child.exited;
    await reading;
    expect(killed).toBe(true);
    expect(code).toBe(143);
    const report = JSON.parse(stdout.trim().split('\n').at(-1)!);
    expect(report).toMatchObject({ status: 'interrupted', signal: 'SIGTERM', source_id: 'notes', phase: 'strict_pass_1', groups_committed: 0, canonical: 'mixed',
      code: 'git_conversion_incomplete', detail: 'interrupted', push: { state: 'skipped', reason: 'durability_not_enabled' } });
    expect(report.scanned).toBeLessThanOrEqual(report.total);
    // The conversion is crash-safe: the source stays mixed, and a new preview applies.
    expect(JSON.parse(cli('sources', 'canonical', 'notes', '--to', 'git', '--dry-run', '--json').trim().split('\n').at(-1)!)).toMatchObject({ strict: false, discard: { count: 0 } });
  }, 300_000);
});

describe('#7644: GBRAIN_MEMORY_TRACE', () => {
  test('is off unless set to 1..3600 seconds', () => {
    expect(memoryTraceIntervalMs({})).toBeNull();
    for (const value of ['', '0', '-5', 'x', '1.5', '3601']) expect(memoryTraceIntervalMs({ GBRAIN_MEMORY_TRACE: value })).toBeNull();
    expect(memoryTraceIntervalMs({ GBRAIN_MEMORY_TRACE: '10' })).toBe(10_000);
  });

  test('writes the label, memory in MB, the caller state and the most numerous heap object types', async () => {
    const line = await memoryTraceLine('sources canonical --apply', Date.now(), { phase: 'strict_pass_1', scanned: 3, total: 9 });
    expect(line.startsWith('[gbrain memory] ')).toBe(true);
    const value = JSON.parse(line.slice('[gbrain memory] '.length));
    expect(value).toMatchObject({ label: 'sources canonical --apply', state: { phase: 'strict_pass_1', scanned: 3, total: 9 } });
    for (const key of ['rss_mb', 'heap_used_mb', 'external_mb', 'array_buffers_mb']) expect(typeof value[key]).toBe('number');
    expect(Object.keys(value.types).length).toBeGreaterThan(0);
  });

  test('emits on its interval only while it runs', async () => {
    const lines: string[] = [];
    expect(startMemoryTrace('off', undefined, {}, line => lines.push(line))()).toBeUndefined();
    const stop = startMemoryTrace('sync', () => ({ round: 1 }), { GBRAIN_MEMORY_TRACE: '1' }, line => lines.push(line));
    for (const deadline = Date.now() + 10_000; lines.length === 0 && Date.now() < deadline;) await Bun.sleep(50);
    stop();
    const seen = lines.length;
    expect(seen).toBeGreaterThanOrEqual(1);
    expect(lines.every(line => line.includes('"label":"sync"') && line.includes('"state":{"round":1}'))).toBe(true);
    // gstack-timing-ok: a stopped trace must stay silent past one full interval; only a regression can add a line here.
    await Bun.sleep(1_200);
    expect(lines.length).toBe(seen);
  });
});
