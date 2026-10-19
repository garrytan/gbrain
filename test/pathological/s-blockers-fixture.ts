/**
 * GBRA-133 lane B (strange-error blockers): one git-backed source per case, synced
 * classic (persistence off, performSync) or managed (claimed worktree,
 * drainManagedSync), on PGLite and on Postgres when DATABASE_URL is set.
 *
 * A case seeds seed.md, takes a first sync, then commits one odd input next to
 * one healthy file (ok/healthy-1.md) and syncs again. The observation records
 * whether the run threw, whether the healthy sibling landed, whether the cursor
 * reached HEAD, and how the odd item was accounted for (imported, ledger row,
 * managed refusal or hold, or nothing). A follow-up commit of ok/healthy-2.md
 * and a third sync shows whether a block is permanent.
 */
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { SyncResult } from '../../src/commands/sync.ts';
import { performSync } from '../../src/commands/sync/perform.ts';
import { drainManagedSync } from '../../src/core/persistence/sync-drain.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { readSyncStatus } from '../../src/core/persistence/sync-status.ts';
import { loadSyncFailures } from '../../src/core/sync-failure-ledger.ts';
import { readGitSourceHolds } from '../../src/core/persistence/sync-holds.ts';
import { readBlockedManagedSyncs } from '../../src/core/persistence/sync-blocked.ts';
import { checkSyncFailures } from '../../src/commands/doctor/checks/sync-failures.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { withEnv } from '../helpers/with-env.ts';

export type SyncMode = 'classic' | 'managed';

export const md = (title: string) => '---\ntitle: ' + title + '\ntype: note\n---\nThe ' + title + ' note.\n';

export interface ProbeRepo {
  mode: SyncMode; engine: BrainEngine; root: string; home: string; sourceId: string;
  git(...args: string[]): string;
  write(path: string | Buffer, body: string | Buffer): void;
  commitAll(msg: string): void;
  sync(opts?: { skipFailed?: boolean; timeoutMs?: number; pull?: boolean }): Promise<SyncResult>;
  lastCommit(): Promise<string | null>;
  head(): string;
}

export interface Observation {
  thrown: string | null;
  status?: string; reason?: string;
  cursorAtHead: boolean;
  healthy: boolean;
  ms: number;
  ledger: Array<{ path: string; code?: string; state?: string; error?: string }>;
  gitHolds: Array<{ path: string; code?: string }>;
  malformedSkipped?: number;
  refusals: Array<{ path: string; code: string }>;
  failures: Array<{ path?: string; slug?: string; code?: string }>;
  status_state?: string; status_reason?: string; status_next?: string; holds?: Array<{ path?: string; code?: string }>;
  doctor?: { sync_failures?: string; managed_blocked?: string };
}

export function errText(e: unknown): string {
  if (!(e instanceof Error)) return 'non-Error: ' + String(e).slice(0, 200);
  const code = (e as { code?: unknown }).code;
  return e.name + (code ? '[' + String(code) + ']' : '') + ': ' + e.message.split('\n')[0]!.slice(0, 300);
}

export function gitIn(root: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'protocol.file.allow=always', '-C', root, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

/** One repo per case on a shared engine. */
export async function withProbeRepo(engine: BrainEngine, mode: SyncMode, home: string,
  run: (r: ProbeRepo) => Promise<void>, opts: { seed?: boolean; root?: string; initRepo?: boolean } = {}): Promise<void> {
  const root = opts.root ?? join(home, 'repo-' + randomUUID().slice(0, 8));
  mkdirSync(root, { recursive: true });
  const git = (...args: string[]) => gitIn(root, ...args);
  if (opts.initRepo !== false) {
    git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Example'); git('config', 'user.email', 'example@example.invalid');
  }
  const write = (path: string | Buffer, body: string | Buffer) => {
    const full = typeof path === 'string' ? join(root, path) : Buffer.concat([Buffer.from(root + '/'), path]);
    mkdirSync(dirname(full.toString('latin1' as never)), { recursive: true });
    writeFileSync(full, body);
  };
  const commitAll = (msg: string) => { git('add', '-A'); git('commit', '-qm', msg, '--allow-empty'); };
  const sourceId = 's' + randomUUID().replace(/-/g, '').slice(0, 14);
  if (opts.seed !== false) { write('seed.md', md('seed')); commitAll('seed'); }
  if (mode === 'managed') await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [sourceId, root]);
  if (mode === 'managed') {
    await claimWorktree(engine, sourceId, root);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  }
  const sync = async (o: { skipFailed?: boolean; timeoutMs?: number; pull?: boolean } = {}) => {
    const p = mode === 'classic'
      ? performSync(engine, { repoPath: root, sourceId, noPull: !o.pull, noEmbed: true, noExtract: true, concurrency: 1, skipFailed: o.skipFailed })
      : drainManagedSync(engine, { sourceId, noPull: !o.pull, noEmbed: true, noExtract: true, skipFailed: o.skipFailed } as never, false);
    const limit = o.timeoutMs ?? 90_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('probe timeout: sync did not return in ' + limit + ' ms')), limit); })]);
    } finally { clearTimeout(timer); }
  };
  const lastCommit = async () => (await engine.executeRaw<{ c: string | null }>('SELECT last_commit AS c FROM sources WHERE id=$1', [sourceId]))[0]?.c ?? null;
  const head = () => { try { return git('rev-parse', 'HEAD'); } catch { return ''; } };
  await run({ mode, engine, root, home, sourceId, git, write, commitAll, sync, lastCommit, head });
}

/** Run one sync and observe it; healthySlug is the sibling that must land for the source to count as moving. */
export async function observe(r: ProbeRepo, healthySlug: string, opts: { skipFailed?: boolean; timeoutMs?: number; pull?: boolean } = {}): Promise<Observation> {
  const started = performance.now();
  let result: SyncResult | undefined; let thrown: string | null = null;
  try { result = await r.sync(opts); } catch (e) { thrown = errText(e); }
  const ms = Math.round(performance.now() - started);
  const healthy = (await r.engine.executeRaw('SELECT 1 FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [r.sourceId, healthySlug])).length > 0;
  const head = r.head();
  const obs: Observation = {
    thrown, status: result?.status, reason: (result as { reason?: string } | undefined)?.reason,
    cursorAtHead: head !== '' && (await r.lastCommit()) === head, healthy, ms,
    ledger: loadSyncFailures().filter(f => f.source_id === r.sourceId).map(f => ({ path: f.path, code: f.code, state: f.state, error: String((f as { error?: unknown }).error ?? '').slice(0, 200) })),
    gitHolds: await readGitSourceHolds(r.engine, { sourceIds: [r.sourceId] }).then(s => (s[0]?.holds ?? []).map(h => ({ path: h.path, code: (h as { code?: string }).code ?? (h as { refusal?: { code?: string } }).refusal?.code })), (e: unknown) => [{ path: '<read failed>', code: errText(e) }]),
    malformedSkipped: (result as { malformedSkipped?: number } | undefined)?.malformedSkipped,
    refusals: (result?.fileRefusals ?? []).map(f => ({ path: f.path, code: f.code })),
    failures: (result?.failures ?? []).map(f => ({ path: (f as { path?: string }).path, slug: (f as { slug?: string }).slug, code: (f as { code?: string }).code })),
  };
  if (r.mode === 'managed') {
    try {
      const status = await readSyncStatus(r.engine, r.sourceId) as unknown as { state?: string; reason?: string; holds?: Array<{ path?: string; code?: string }> };
      obs.status_state = status.state; obs.status_reason = status.reason;
      obs.status_next = JSON.stringify((status as { next?: unknown }).next ?? null).slice(0, 300);
      obs.holds = (status.holds ?? []).map(h => ({ path: h.path, code: h.code }));
    } catch (e) { obs.status_state = 'status threw: ' + errText(e); }
  }
  const doctor: Observation['doctor'] = {};
  try {
    const check = await checkSyncFailures(r.engine, { sourceIds: [r.sourceId], remote: false });
    doctor.sync_failures = check ? check.status + ': ' + String(check.message).slice(0, 200) : 'null';
  } catch (e) { doctor.sync_failures = 'threw: ' + errText(e); }
  try {
    const blocked = await readBlockedManagedSyncs(r.engine, [r.sourceId]);
    doctor.managed_blocked = blocked.length ? blocked.map(b => b.code).join(',') : 'none';
  } catch (e) { doctor.managed_blocked = 'threw: ' + errText(e); }
  obs.doctor = doctor;
  return obs;
}

/** The engine arm (one engine per mode and backend) with a temp GBRAIN_HOME and ledger dir. */
export async function withProbeEngine(databaseUrl: string | undefined, run: (engine: BrainEngine, home: string) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-s-blockers-'));
  try {
    await withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, GBRAIN_AUDIT_DIR: join(home, 'audit'), GBRAIN_SYNC_AUTOSKIP_AFTER: '3', GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1',
      DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try { await run(engine, home); } finally { await disposePersistenceConsumer(engine); await close(); }
    });
  } finally {
    try { execFileSync('chmod', ['-R', 'u+rwX', home]); } catch { /* best effort */ }
    rmSync(home, { recursive: true, force: true });
  }
}

export function record(row: Record<string, unknown>): void {
  const out = process.env.GBRAIN_TEST_S_PROBE_OUT;
  if (out) appendFileSync(out, JSON.stringify(row) + '\n');
}
