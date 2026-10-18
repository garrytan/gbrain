/**
 * Shared fixture of the Git effect coalescing files (#5530) and the native Git durability probe
 * file (#6210): a hardened local repository with a push-counting bare remote, a brain per test
 * (PGLite, or a clone of one migrated Postgres template), and the paused-then-drained effect
 * runner that makes commit and push counts deterministic.
 *
 * Each test file creates its own fixture (`createGitCoalescingFixture`) and registers
 * `dispose` in its `afterAll`: the repository templates and the Postgres template are per file.
 */
import { expect } from 'bun:test';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { PAGE_BATCH_MAX_PAGES, submitPageBatch } from '../../src/core/persistence/page-batch.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { runPersistenceEffects } from '../../src/core/persistence/effects.ts';
import { localHostId } from '../../src/core/persistence/identity.ts';
import { declarePersistenceProtocol } from '../../src/core/persistence/protocol.ts';
import { isolatedSharedSkillsEngine } from './shared-skills-engine.ts';
import { persistencePostgresTemplate } from './persistence-postgres.ts';
import { withEnv } from './with-env.ts';

export const HOOK = '#!/bin/sh\n# gbrain brain-durability post-commit hook (v0.42.44+)\n';

export function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', '-C', root, ...args]);
  if (result.exitCode) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`);
  return result.stdout.toString();
}

export interface Repo { root: string; remote: string; pushes: () => number; rejectPushes: (on: boolean) => void; commits: () => number }

export interface CoalescingBrain { engine: BrainEngine; home: string; ctx: (source: string) => OperationContext }

export const pageContent = (i: number, note = '') => `---\ntype: note\ntitle: Page ${i}\n---\n\nCoalescing page ${i}.${note}\n`;
export const pageSlug = (i: number) => `notes/page-${String(i).padStart(4, '0')}`;

/** One page through `put_page`: the single writes a test observes (a target page, a probe) stay on this path. */
export async function putPage(ctx: OperationContext, i: number): Promise<Record<string, unknown>> {
  return await submitPageMutation(ctx, { operation: 'put_page', params: { slug: pageSlug(i), request_id: randomUUID(), content: pageContent(i) } }) as Record<string, unknown>;
}

/**
 * Setup-only pages through `put_pages` in batches of PAGE_BATCH_MAX_PAGES: one admission transaction
 * per batch instead of one write round per page, with the same `kind='git'` effect row per page (the
 * 5530 file asserts that equality). Batches are sequential, so effect ids follow page order.
 */
export async function seed(ctx: OperationContext, count: number, offset = 0): Promise<void> {
  for (let start = offset; start < offset + count; start += PAGE_BATCH_MAX_PAGES) {
    const pages = Array.from({ length: Math.min(PAGE_BATCH_MAX_PAGES, offset + count - start) }, (_, k) => ({ slug: pageSlug(start + k), content: pageContent(start + k) }));
    const receipt = await submitPageBatch(ctx, { request_id: randomUUID(), pages });
    expect(receipt.state).toBe('committed');
  }
}

/** `put_page` once per page, the pre-batch seed: kept for the seed-equality assertion only. */
export async function seedSequentially(ctx: OperationContext, count: number, offset = 0): Promise<void> {
  for (let i = offset; i < offset + count; i++) await putPage(ctx, i);
}

export async function bindSource(engine: BrainEngine, source: string, repo: Repo): Promise<void> {
  if (source !== 'default') await engine.executeRaw('INSERT INTO sources (id, name, local_path) VALUES ($1, $1, $2)', [source, repo.root]);
  else await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [repo.root]);
  await claimWorktree(engine, source, repo.root, localHostId());
}

/** Git effects are held back with a future `next_attempt_at` default while `run` writes, then the consumer is disposed. */
export async function pauseGitEffects<T>(engine: BrainEngine, run: () => Promise<T>): Promise<T> {
  await engine.executeRaw("ALTER TABLE persistence_effects ALTER COLUMN next_attempt_at SET DEFAULT (now()+interval '1 hour')");
  try { return await run(); } finally {
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('ALTER TABLE persistence_effects ALTER COLUMN next_attempt_at SET DEFAULT now()');
  }
}

export const effectSql = (engine: BrainEngine, sql: string, params: unknown[] = []) =>
  engine.transaction(async tx => { await declarePersistenceProtocol(tx); await tx.executeRaw(sql, params); });
export const release = (engine: BrainEngine) => effectSql(engine, "UPDATE persistence_effects SET next_attempt_at=now() WHERE kind='git' AND state='queued'");
export const pass = (engine: BrainEngine) => runPersistenceEffects(engine, { engine: engine.kind, embedding_disabled: true } as never, { hostId: localHostId(), limit: 20 });
export const gitStates = async (engine: BrainEngine) => Object.fromEntries((await engine.executeRaw<{ state: string; n: number }>(
  "SELECT state, count(*)::int AS n FROM persistence_effects WHERE kind='git' GROUP BY state ORDER BY state")).map(r => [r.state, Number(r.n)]));

export function harden(repo: Repo): void {
  git(repo.root, 'add', '-A'); git(repo.root, 'commit', '-q', '-m', 'Seed', '--allow-empty'); git(repo.root, 'push', '-q');
  rmSync(join(repo.remote, '..', `${repo.root.split('/').pop()}.pushes`), { force: true });
  const hook = join(repo.root, '.git', 'hooks', 'post-commit');
  writeFileSync(hook, HOOK); chmodSync(hook, 0o755);
}

export function createGitCoalescingFixture(tag: string) {
  // Each repository shape is built once per file and copied per test: a fresh repository costs ten
  // git processes, and under CPU contention process startup dominated every test that made one.
  let repoTemplates: string | undefined;
  function repoTemplate(name: string): string {
    repoTemplates ??= realpathSync.native(mkdtempSync(join(tmpdir(), `gbrain-coalesce-${tag}-repos-`)));
    const root = join(repoTemplates, name), remote = join(repoTemplates, `${name}.git`);
    if (existsSync(remote)) return repoTemplates;
    mkdirSync(root); mkdirSync(remote);
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.name', 'Example Writer');
    git(root, 'config', 'user.email', 'writer@example.invalid');
    writeFileSync(join(root, 'README.md'), `${name}\n`);
    git(root, 'add', 'README.md'); git(root, 'commit', '-q', '-m', 'Initial');
    git(remote, 'init', '-q', '--bare');
    git(root, 'remote', 'add', 'origin', remote); git(root, 'push', '-q', '-u', 'origin', 'main');
    return repoTemplates;
  }

  function makeRepo(home: string, name: string): Repo {
    const root = join(home, name), remote = join(home, `${name}.git`), log = join(home, `${name}.pushes`), reject = join(home, `${name}.reject`);
    const template = repoTemplate(name);
    cpSync(join(template, name), root, { recursive: true });
    cpSync(join(template, `${name}.git`), remote, { recursive: true });
    git(root, 'remote', 'set-url', 'origin', remote);
    const preReceive = join(remote, 'hooks', 'pre-receive');
    writeFileSync(preReceive, `#!/bin/sh\necho push >> '${log}'\n[ -f '${reject}' ] && exit 1\nexit 0\n`);
    chmodSync(preReceive, 0o755);
    return {
      root, remote,
      pushes: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).length : 0,
      rejectPushes: on => { if (on) writeFileSync(reject, ''); else rmSync(reject, { force: true }); },
      commits: () => Number(git(root, 'rev-list', '--count', 'HEAD').trim()),
    };
  }

  // PostgreSQL brains are clones of one migrated template database rather than a full migration run per test.
  let pgTemplate: ReturnType<typeof persistencePostgresTemplate> | undefined;

  async function withBrain(kind: 'pglite' | 'postgres', run: (b: CoalescingBrain) => Promise<void>) {
    const home = realpathSync.native(mkdtempSync(join(tmpdir(), `gbrain-coalesce-${tag}-`)));
    try {
      await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
        const { engine, close } = kind === 'postgres'
          ? await (pgTemplate ??= persistencePostgresTemplate(process.env.GBRAIN_TEST_COALESCE_PG!)).then(template => template.clone())
          : await isolatedSharedSkillsEngine();
        try {
          const ctx = (source: string) => ({ engine, config: { engine: engine.kind, embedding_disabled: true }, sourceId: source,
            remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} } }) as OperationContext;
          await run({ engine, home, ctx });
        } finally { await disposePersistenceConsumer(engine); await close(); }
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  }

  async function dispose(): Promise<void> {
    await (await pgTemplate)?.dispose();
    if (repoTemplates) rmSync(repoTemplates, { recursive: true, force: true });
  }

  return { makeRepo, withBrain, dispose };
}
