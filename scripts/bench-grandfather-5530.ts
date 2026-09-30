#!/usr/bin/env bun
/**
 * #5530 benchmark: wall time per page for the v0.13.1 managed grandfather
 * step on a durability-hardened canonical repository that tracks a local
 * bare remote. Every page is its own admitted put_page; the measurement
 * covers admission, publication and the page's Git commit and push.
 *
 *   bun scripts/bench-grandfather-5530.ts [--pages 250] [--postgres <url>] [--no-harden] [--no-push] [--json]
 *
 * --no-harden skips the durability hook, so Git effects record without running
 * git: the difference between the two runs is the Git share of the step.
 * --no-push unsets the branch upstream, so effects commit but never push.
 *
 * Isolated: a temporary GBRAIN_HOME, an in-memory PGLite brain (or a fresh
 * database on the given test Postgres server) and a local bare remote. It
 * never opens an operator brain and never reaches the network.
 */
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}
const pages = Number(arg('--pages') ?? 250);
const databaseUrl = arg('--postgres');
const json = process.argv.includes('--json');
const harden = !process.argv.includes('--no-harden');
const push = !process.argv.includes('--no-push');

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', '-C', root, ...args]);
  if (result.exitCode) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`);
  return result.stdout.toString();
}

const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'gbrain-bench-5530-')));
process.env.GBRAIN_HOME = home;
delete process.env.DATABASE_URL;
delete process.env.GBRAIN_DATABASE_URL;

const { phaseCGrandfather } = await import('../src/commands/migrations/v0_13_1.ts');
const { claimWorktree } = await import('../src/core/persistence/ownership.ts');
const { activateSharedSkillPersistence } = await import('../src/core/persistence/skill-activation.ts');
const { submitPageMutation } = await import('../src/core/persistence/page-mutations.ts');
const { disposePersistenceConsumer } = await import('../src/core/persistence/service.ts');
const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
const { runPersistenceEffects } = await import('../src/core/persistence/effects.ts');
const { localHostId } = await import('../src/core/persistence/identity.ts');

const root = join(home, 'content'), remote = join(home, 'remote.git');
mkdirSync(root); mkdirSync(remote);
git(root, 'init', '-q', '-b', 'main');
git(root, 'config', 'user.name', 'Example Writer');
git(root, 'config', 'user.email', 'writer@example.invalid');
writeFileSync(join(root, 'README.md'), 'Benchmark\n');
git(root, 'add', 'README.md'); git(root, 'commit', '-q', '-m', 'Initial');
git(remote, 'init', '-q', '--bare');
git(root, 'remote', 'add', 'origin', remote); git(root, 'push', '-q', '-u', 'origin', 'main');

let engine: import('../src/core/engine.ts').BrainEngine, close: () => Promise<void>;
if (databaseUrl) {
  const { isolatedPersistencePostgres } = await import('../test/helpers/persistence-postgres.ts');
  ({ engine, close } = await isolatedPersistencePostgres(databaseUrl));
} else {
  const pglite = new PGLiteEngine(); await pglite.connect({}); await pglite.initSchema();
  engine = pglite; close = () => pglite.disconnect();
}
try {
  await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
  await claimWorktree(engine, 'default', root);
  await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
  const ctx = { engine, config: { engine: engine.kind, embedding_disabled: true }, sourceId: 'default',
    remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} } } as never;
  // Seed before hardening, so the seed writes skip Git and only the step under test commits and pushes.
  for (let i = 0; i < pages; i++) {
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug: `notes/page-${String(i).padStart(4, '0')}`, request_id: randomUUID(),
      content: `---\ntype: note\ntitle: Page ${i}\n---\n\nBenchmark page ${i}.\n` } });
  }
  await disposePersistenceConsumer(engine);
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'Seed'); git(root, 'push', '-q');
  if (harden) {
    const hook = join(root, '.git', 'hooks', 'post-commit');
    writeFileSync(hook, '#!/bin/sh\n# gbrain brain-durability post-commit hook (v0.42.44+)\n');
    chmodSync(hook, 0o755);
  }
  if (!push) git(root, 'branch', '--unset-upstream');
  const commitsBefore = Number(git(root, 'rev-list', '--count', 'HEAD').trim());
  const started = performance.now();
  const result = await phaseCGrandfather(engine, { yes: true, dryRun: false, noAutopilotInstall: true } as never);
  const stepSeconds = (performance.now() - started) / 1000;
  await disposePersistenceConsumer(engine);
  // Git work the step left queued still has to run before the pages are backed up.
  await engine.executeRaw("UPDATE persistence_effects SET next_attempt_at=now() WHERE state='queued'").catch(() => undefined);
  while (await runPersistenceEffects(engine, ctx.config as never, { hostId: localHostId(), limit: 20 }) > 0);
  const seconds = (performance.now() - started) / 1000;
  const commits = Number(git(root, 'rev-list', '--count', 'HEAD').trim()) - commitsBefore;
  const remoteHead = git(remote, 'rev-parse', 'main').trim() === git(root, 'rev-parse', 'HEAD').trim();
  const report = { engine: engine.kind, pages, hardened: harden, push, touched: result.detail.touched, failed: result.detail.failed, failures: result.detail.failures.slice(0, 3),
    step_seconds: Number(stepSeconds.toFixed(2)), seconds: Number(seconds.toFixed(2)), seconds_per_page: Number((seconds / pages).toFixed(3)), commits, remote_matches_head: push ? remoteHead : null,
    platform: `${process.platform}-${process.arch}`, bun: Bun.version };
  console.log(json ? JSON.stringify(report) : Object.entries(report).map(([k, v]) => `${k}: ${v}`).join('\n'));
} finally {
  await disposePersistenceConsumer(engine);
  await close();
  rmSync(home, { recursive: true, force: true });
}
