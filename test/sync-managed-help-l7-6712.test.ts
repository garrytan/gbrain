/**
 * #6712 PR 3 (L7): the managed sync surface an operator or a cron needs.
 *
 * - `gbrain sync --help` lists the "Managed brains" flags first (at most 10, exactly `MANAGED_HELP_FLAGS`), then a
 *   "Classic brains / advanced" section with every other flag; no flag is listed twice.
 * - Doctor's printed managed cron recipe passes the managed flag validator (parse, the managed-forbidden refusal, the
 *   hard-deadline resolution) and syncs every source of a managed brain. `--all`, `--hard-deadline`, `--no-bulk` and
 *   `--no-lanes` stay accepted on a managed source.
 * - `--retry-failed` is a deprecated alias of the plain sync: it prints the `sync_retry_failed_deprecated` coaching
 *   notice once and syncs exactly like the plain command.
 * - Every removed state renders `superseded`: retired registry codes and the legacy knock-on receipts older builds wrote.
 * - The plain sync replays a content refusal without a new request while the file and the gbrain version that recorded it
 *   are unchanged, and retries a failure an older build recorded (it carries no `gbrain_version`).
 *
 * Regression guarded: a managed flag dropped from the managed section or left out of `MANAGED_HELP_FLAGS`, the
 * cron recipe naming a flag the managed validator refuses, or `--retry-failed` silently changing what a sync does.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { runSync } from '../src/commands/sync.ts';
import { noteRetryFailedDeprecated, parseSyncFlags, printSyncHelp, resetRetryFailedNoticeForTests, RETRY_FAILED_DEPRECATED } from '../src/commands/sync/args.ts';
import { refuseManagedForbiddenFlags } from '../src/commands/sync/managed-no-pull.ts';
import { checkSyncConsolidation } from '../src/commands/doctor.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { readManagedSyncFailures } from '../src/core/persistence/sync-failures.ts';
import { VERSION } from '../src/version.ts';
import { managedForbiddenFlag } from '../src/core/persistence/managed-sync-flags.ts';
import { MANAGED_HELP_FLAGS, SYNC_FLAGS } from '../src/core/sync-flags.ts';
import { resolveSyncHardDeadline } from '../src/core/sync-reconcile.ts';
import { CODES, NOTICE_CODES } from '../src/core/error-registry.ts';
import { publicCategory } from '../src/core/persistence/public-category.ts';
import { classifyTerminal } from '../src/core/persistence/terminal-classify.ts';
import { BULK_GROUP_CANCEL_MESSAGE, knockOnDetail, LEGACY_KNOCK_ON_CANCEL_MESSAGES } from '../src/core/persistence/sync-knock-on.ts';
import { laneFaultCancelMessage, WINDOW_CANCEL_MESSAGE } from '../src/core/persistence/sync-window.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-managed-help-'));
let engine: BrainEngine;
const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, GBRAIN_BACKUP_CHECK: 'off', GBRAIN_SYNC_NO_EXTRACT_NUDGE: '1', OPENAI_API_KEY: undefined };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  // The recipe carries no --no-embed, so the embedding preflight needs a configured key; the sync itself never calls the provider.
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-test-not-a-key' } });
}, 120_000);
afterAll(async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });
  resetGateway();
  rmSync(home, { recursive: true, force: true });
});

/** Managed sources, each a one-commit checkout; every other source is left out of `--all`. */
async function managedSources(count: number): Promise<Array<{ id: string; head: string }>> {
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("UPDATE sources SET config=jsonb_set(config,'{syncEnabled}','false'::jsonb)");
  const made: Array<{ id: string; head: string }> = [];
  for (let i = 0; i < count; i++) {
    const id = `help-${randomUUID().slice(0, 12)}`, root = join(home, id);
    mkdirSync(root); git(root, 'init', '-q');
    writeFileSync(join(root, 'a.md'), '---\ntitle: a\n---\nA durable observation about acme-example.\n');
    git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'seed');
    await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
    await claimWorktree(engine, id, root);
    made.push({ id, head: git(root, 'rev-parse', 'HEAD') });
  }
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return made;
}
const lastCommit = async (id: string) => (await engine.executeRaw<{ last_commit: string | null }>('SELECT last_commit FROM sources WHERE id=$1', [id]))[0]?.last_commit ?? null;
async function captured<T>(fn: () => Promise<T>): Promise<{ value: T; stderr: string; exitCode?: number }> {
  const origError = console.error, origLog = console.log, origWrite = process.stderr.write.bind(process.stderr), origOut = process.stdout.write.bind(process.stdout);
  let stderr = '';
  console.error = (...parts: unknown[]) => { stderr += parts.join(' ') + '\n'; }; console.log = () => {};
  process.stderr.write = ((chunk: string | Uint8Array) => { stderr += String(chunk); return true; }) as typeof process.stderr.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  const origExit = process.exit;
  let exitCode: number | undefined;
  process.exit = ((code?: number) => { exitCode = code ?? 0; throw new Error('fixture-cli-exit'); }) as typeof process.exit;
  try {
    const value = await fn().catch((error: unknown) => { if ((error as Error)?.message === 'fixture-cli-exit') return undefined as T; throw error; });
    return { value, stderr, exitCode };
  } finally { console.error = origError; console.log = origLog; process.stderr.write = origWrite; process.stdout.write = origOut; process.exit = origExit; }
}

/** The option flags printed under each help section, in order. */
function helpSections(): { managed: string[]; classic: string[]; order: string[] } {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...parts: unknown[]) => { lines.push(...parts.join(' ').split('\n')); };
  try { printSyncHelp(); } finally { console.log = log; }
  const managedAt = lines.findIndex(line => line.startsWith('Managed brains'));
  const classicAt = lines.findIndex(line => line.startsWith('Classic brains / advanced'));
  const flags = (from: number, to: number) => lines.slice(from + 1, to).flatMap(line => /^  (--[a-z][a-z-]*)/.exec(line)?.[1] ?? []);
  const end = lines.findIndex((line, i) => i > classicAt && /^\S/.test(line));
  return { managed: flags(managedAt, classicAt), classic: flags(classicAt, end === -1 ? lines.length : end), order: [String(managedAt), String(classicAt)] };
}

test('sync --help lists the managed flags first (at most 10, exactly MANAGED_HELP_FLAGS), then every other flag under Classic', () => {
  const { managed, classic, order } = helpSections();
  expect(Number(order[0])).toBeGreaterThan(0);
  expect(Number(order[1])).toBeGreaterThan(Number(order[0]));
  expect(managed.length).toBeLessThanOrEqual(10);
  expect([...managed].sort()).toEqual([...MANAGED_HELP_FLAGS].sort());
  expect(managed.filter(flag => classic.includes(flag))).toEqual([]);
  expect(new Set(managed).size).toBe(managed.length);
  expect(new Set(classic).size).toBe(classic.length);
  // The flags a managed source refuses, and the deprecated alias, are classic.
  for (const flag of ['--skip-failed', '--include-gitignored', '--retry-failed', '--full', '--no-embed']) expect(classic).toContain(flag);
  // Every flag the help documents is a parsed sync flag.
  const parsed = Object.keys(SYNC_FLAGS);
  expect([...managed, ...classic].filter(flag => !parsed.includes(flag) && !['--help', '--watch', '--interval', '--repo', '--force-break-lock', '--max-age', '--yes', '--missing-path', '--parallel', '--workers', '--concurrency', '--serial'].includes(flag))).toEqual([]);
  // No managed flag is one a managed source refuses.
  for (const flag of managed) expect(['--skip-failed', '--include-gitignored']).not.toContain(flag);
});

test("doctor's managed cron recipe passes the managed flag validator and syncs every source", async () => withEnv(env, async () => {
  const sources = await managedSources(2);
  const check = await checkSyncConsolidation(engine);
  const recipe = /`(gbrain sync [^`]+)`/.exec(check.message)?.[1];
  expect(recipe).toBe('gbrain sync --all --no-pull --hard-deadline 13m');
  const args = recipe!.split(' ').slice(2);
  for (const flag of args.filter(arg => arg.startsWith('--'))) expect(MANAGED_HELP_FLAGS as string[]).toContain(flag);
  const flags = parseSyncFlags(args);
  expect(flags).toMatchObject({ syncAll: true, noPull: true, skipFailed: false, includeGitignored: false });
  expect(managedForbiddenFlag(flags)).toBeNull();
  await refuseManagedForbiddenFlags(engine, flags, args);
  expect(resolveSyncHardDeadline(args, { isTty: false, env: {} })).toMatchObject({ deadlineMs: 13 * 60_000, reason: 'flag:--hard-deadline' });
  expect((await captured(() => runSync(engine, args))).exitCode).toBeUndefined();
  for (const source of sources) expect(await lastCommit(source.id)).toBe(source.head);
}), 120_000);

test('--all, --hard-deadline, --no-bulk and --no-lanes stay accepted on a managed source', async () => withEnv(env, async () => {
  const [source] = await managedSources(1);
  await captured(() => runSync(engine, ['--source', source!.id, '--no-pull', '--no-bulk', '--no-lanes', '--hard-deadline', '13m']));
  expect(await lastCommit(source!.id)).toBe(source!.head);
  const [other] = await managedSources(1);
  await captured(() => runSync(engine, ['--all', '--no-pull', '--no-bulk', '--no-lanes', '--hard-deadline', '13m']));
  expect(await lastCommit(other!.id)).toBe(other!.head);
}), 120_000);

test('--retry-failed is a deprecated alias of the plain sync: it prints the coaching notice once and syncs the same', async () => withEnv(env, async () => {
  expect(NOTICE_CODES.sync_retry_failed_deprecated).toMatchObject({ kind: 'coaching' });
  expect(RETRY_FAILED_DEPRECATED).toContain('a plain gbrain sync now retries');
  resetRetryFailedNoticeForTests();
  const plainSource = (await managedSources(1))[0]!;
  const plain = await captured(() => runSync(engine, ['--source', plainSource.id, '--no-pull']));
  expect(plain.stderr).not.toContain('sync_retry_failed_deprecated');
  const aliasSource = (await managedSources(1))[0]!;
  const alias = await captured(() => runSync(engine, ['--source', aliasSource.id, '--no-pull', '--retry-failed']));
  expect(alias.stderr.match(/\[gbrain notice sync_retry_failed_deprecated\]/g)).toHaveLength(1);
  expect(alias.stderr).toContain(RETRY_FAILED_DEPRECATED);
  expect(await lastCommit(plainSource.id)).toBe(plainSource.head);
  expect(await lastCommit(aliasSource.id)).toBe(aliasSource.head);
  // Once per process: the CLI pipeline and the sync command both call it.
  const again = await captured(async () => noteRetryFailedDeprecated(['--retry-failed']));
  expect(again.stderr).toBe('');
}), 120_000);

test('every removed state renders superseded: retired codes, and the legacy knock-on receipts older builds wrote', () => {
  const retired = Object.entries(CODES).filter(([, entry]) => (entry as { retired_in?: string }).retired_in).map(([code]) => code);
  expect(retired.length).toBeGreaterThan(0);
  for (const code of retired) expect([code, publicCategory({ code })]).toEqual([code, 'superseded']);
  const row = (state: string, code: string, message: string | null, detail: object | null = null) => classifyTerminal({ request_id: 'r', source_id: 'default', slug: 's',
    operation: 'submit_job', state, error_code: code, error_detail: detail, recovery: null, blocked_reason: null, compacted: false, publication_started: false,
    intent_kind: 'managed_sync_import', error_message: message });
  const legacy = [
    row('cancelled', 'cancelled', WINDOW_CANCEL_MESSAGE),
    row('cancelled', 'cancelled', laneFaultCancelMessage('lock_timeout')),
    row('cancelled', 'cancelled', BULK_GROUP_CANCEL_MESSAGE),
    ...LEGACY_KNOCK_ON_CANCEL_MESSAGES.map(message => row('cancelled', 'cancelled', message)),
    row('cancelled', 'storage_error', null, knockOnDetail('window_predecessor', null)),
  ];
  for (const verdict of legacy) expect(verdict).toMatchObject({ public_category: 'superseded' });
});


test('a content refusal replays without a new request while the file and the recording version are unchanged, and a failure an older build recorded is retried once', async () => withEnv(env, async () => {
  const [source] = await managedSources(1);
  const root = (await engine.executeRaw<{ local_path: string }>('SELECT local_path FROM sources WHERE id=$1', [source!.id]))[0]!.local_path;
  writeFileSync(join(root, 'bad.md'), '---\ntitle: [broken\n---\nBroken content.\n');
  git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'bad');
  await engine.setConfig('sync.holds', 'fail');
  const opts = { sourceId: source!.id, noPull: true, noEmbed: true, noExtract: true };
  const requestOf = async () => (await readManagedSyncFailures(engine, [source!.id]))[0]?.request_id;
  try {
    expect((await performManagedSync(engine, opts)).status).toBe('blocked_by_failures');
    const first = await requestOf();
    expect(first).toBeTruthy();
    expect((await readManagedSyncFailures(engine, [source!.id]))[0]).toMatchObject({ gbrain_version: VERSION });
    expect((await performManagedSync(engine, opts)).status).toBe('blocked_by_failures');
    expect(await requestOf()).toBe(first);
    // A row an older build recorded carries no gbrain_version: its parser may have refused what this one reads, so it is retried.
    await engine.executeRaw("UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0}',(completed_keys->0)-'gbrain_version') WHERE op='managed-sync-failure' AND completed_keys->0->>'source_id'=$1", [source!.id]);
    expect((await performManagedSync(engine, opts)).status).toBe('blocked_by_failures');
    const retried = await requestOf();
    expect(retried).not.toBe(first);
    expect((await performManagedSync(engine, opts)).status).toBe('blocked_by_failures');
    expect(await requestOf()).toBe(retried);
  } finally { await engine.executeRaw("DELETE FROM config WHERE key='sync.holds'"); }
}), 120_000);

