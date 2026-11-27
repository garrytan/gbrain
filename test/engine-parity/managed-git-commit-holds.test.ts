/**
 * Engine parity: a managed Git commit that cannot be made is loud in `gbrain sync status` (git_commit_holds).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on a host with no Git identity, a bound put_page commits the page; its Git effect fails `git_unavailable`
 *    at the commit step and keeps exactly the step and a reason code (`last_error` {phase, step, reason, identity});
 *    attempts 1-4 requeue, attempt 5 parks (PARK_AFTER_FAILURES); writer status and doctor parked_effects list it;
 *    `gbrain sync status` JSON carries `git_commit_holds` with the step, `reason: identity_missing` and
 *    `owner_host: this_host`; its `next` is the identity question for the user (ask_user), `needs_human` is true with
 *    `needs_human_from.kind: git_commit`, and the text names the hold, prints ASK THE USER and never says "holds
 *    nothing". Setting the checkout's identity and the documented retry then commits the file and clears the hold. A
 *    clean filter that prints a token-bearing URL and an Authorization header stores and prints none of git's words:
 *    the effect keeps {phase: commit, step: add, reason: filter_failed}. PGLite, Postgres and Rust print the same bytes.
 *  - Regression: the hold missing from sync status (git_unavailable not read there), the step or reason lost, any of
 *    git's stderr stored or printed (GCH-01), a hold the user must answer that sync status reports as needing nobody
 *    (GCH-02 follow-up F2), a Rust sync status that never reads Git holds, or the arms printing different output.
 *  - Why existing coverage misses it: managed-git-missing-identity.test.ts pins the park on PGLite only and reads no
 *    sync status; no test fed a secret through a git step's stderr.
 *  - Rust: the failure record's recovery probe (persistence/effects.ts recordFailure) is raw SQL, so on a Rust brain
 *    (single-host and multi-user) the lifecycle case stops on a typed raw_sql refusal at the first failed attempt
 *    (docs/designs/RUST_ENGINE.md conflict row 55a). WAITING: it must run equal on the Rust arms once lane 7's typed
 *    effectRecovering (20da396ebd) reaches rust-engine/multiuser (it rides rust-engine/managed-on-rust-2b to main), and
 *    before multi-user mode turns on by default. Until then the second case proves the output on every arm: on Rust it
 *    stands lane 7's probe in by name (effects.ts effectRecoverySeam, answering "no recovery record"), and the arms
 *    compare the sync status bytes.
 *  - Slice 4 (GCH-03a, F1, F2a): a put whose push fails is a push hold that names the step and reason (`last_error`,
 *    the text's "at step X (reason: Y)") and pushes once the remote is back, with its tracking ref pruned (F1). A
 *    removal whose push failed, retried after its tracking ref was pruned, pushes and never completes unpushed
 *    (GCH-03a). A commit hold that asks the user still sets `needs_human` (from `git_commit`) while a recovery record is
 *    `next`, so the JSON and the text's ASK THE USER agree (F2a). Rust: F1 and F2a run equal with the recovery probe
 *    seamed (effectRecoverySeam, restored in finally). The GCH-03a removal STOPS on Rust at delete_page preparation
 *    (file-claims.ts findLiveFileClaimants is raw SQL; the page-prepare item, due 2026-12-10). PGLite and Postgres run
 *    every case unseamed.
 *  - Seams: retries come due at once (requeueEffectRow with delayMs 0, a typed member every arm serves). In the two push
 *    cases (`slowPushRecord`) that same member waits SLOW_PUSH_RECORD_MS before it requeues a failed push, so the
 *    attempt is certainly still `running` while the drain starts (a slow `git` cannot do it: the effect runs git
 *    synchronously, which holds the whole process). Real engines, real Git checkouts.
 *  - Drains: submitPageMutation starts this process's background consumer, which can claim a Git effect while the test
 *    drains. A claimed effect is `running` (a valid lease) until its worker records the attempt, so drainGit waits until
 *    the row leaves `running` and the expected state holds, bounded by time with a message naming the last state. A
 *    drain that only counted passes (20 passes, no wait) returned while the push was in flight and read
 *    {state: running, code: null}; with slowPushRecord and claimedGit that drain fails on every run, and drainGit passes.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect } from 'bun:test';
import { createSource, parityArms, type ParityBackend } from './harness.ts';
import { liftManagedHold } from './rust-managed.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { writerAdminState } from '../../src/core/persistence/admin-intent.ts';
import { runPersistenceAdministration } from '../../src/core/persistence/administration.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { hostIdFor, readLocalWriter } from '../../src/core/persistence/identity.ts';
import { effectRecoverySeam, runPersistenceEffects } from '../../src/core/persistence/effects.ts';
import { readSyncStatus } from '../../src/core/persistence/sync-status.ts';
import { runSyncStatus } from '../../src/commands/sync/operator.ts';
import { checkParkedEffects } from '../../src/commands/doctor/checks/parked-effects.ts';

const { parityTest } = parityArms(testBackends());

const GIT_ID = ['-c', 'user.name=Example', '-c', 'user.email=example@example.invalid'];
const SECRET_URL = 'https://alice-example:hunter2tokenvalue@git.example.invalid/acme.git?access_token=qq9secretquerytoken';
const SECRET_HEADER = 'Authorization: Bearer zz8secretbearervalue';


const ctxFor = (engine: BrainEngine, sourceId: string) => ({ engine, sourceId, remote: false as const,
  config: { engine: engine.kind, embedding_disabled: true }, dryRun: false, logger: { info() {}, warn() {}, error() {} } });

/**
 * A claimed, durable checkout of source `work` on a host with no Git identity anywhere (HOME, a global config with
 * user.useConfigOnly so git guesses none, no system config, no identity variables). Retries come due at once; see the
 * header.
 */
/** What the effect worker wrote at each failed attempt (requeue or park), read at the typed member it writes through. */
type Written = { kind: 'requeue' | 'park'; reason: string | null; data: Record<string, any> };

async function withNoIdentityCheckout<T>(engine: BrainEngine, backend: ParityBackend, opts: { source?: string; identity?: boolean; slowPushRecord?: boolean },
  run: (home: string, root: string, written: Written[]) => Promise<T>): Promise<T> {
  const source = opts.source ?? 'work';
  if (backend === 'rust') liftManagedHold(engine);
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-commit-holds-')));
  const bare = join(home, 'no-identity'); mkdirSync(bare, { recursive: true });
  writeFileSync(join(bare, 'gitconfig'), '[user]\n\tuseConfigOnly = true\n');
  const target = engine as unknown as Record<string, unknown>;
  const requeue = engine.requeueEffectRow.bind(engine), park = engine.parkEffectRow.bind(engine);
  const written: Written[] = [];
  target.requeueEffectRow = (o: Parameters<BrainEngine['requeueEffectRow']>[0]) => {
    written.push({ kind: 'requeue', reason: o.reason, data: JSON.parse(o.dataJson) });
    // `slowPushRecord` (see the header): a failed push's requeue waits first, so its row stays claimed and `running`.
    if (opts.slowPushRecord && o.reason === 'git_push_unavailable') return Bun.sleep(SLOW_PUSH_RECORD_MS).then(() => requeue({ ...o, delayMs: 0 }));
    return requeue({ ...o, delayMs: 0 });
  };
  target.parkEffectRow = (o: Parameters<BrainEngine['parkEffectRow']>[0]) => {
    written.push({ kind: 'park', reason: null, data: JSON.parse(o.dataJson) });
    return park(o);
  };
  try {
    return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1',
      HOME: bare, GIT_CONFIG_GLOBAL: join(bare, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', EMAIL: undefined, GBRAIN_SOURCE: undefined,
      GIT_AUTHOR_NAME: undefined, GIT_AUTHOR_EMAIL: undefined, GIT_COMMITTER_NAME: undefined, GIT_COMMITTER_EMAIL: undefined }, async () => {
      const root = join(home, 'checkout');
      mkdirSync(join(root, 'notes'), { recursive: true });
      execFileSync('git', ['-C', root, 'init', '-q', '-b', 'main']);
      writeFileSync(join(root, 'notes', 'alice-example.md'), '---\ntitle: Alice Example\n---\nWorks at acme-example.\n');
      execFileSync('git', ['-C', root, 'add', '.']);
      execFileSync('git', ['-C', root, ...GIT_ID, 'commit', '-qm', 'notes']);
      const remote = join(home, 'remote.git');
      execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
      execFileSync('git', ['-C', root, 'remote', 'add', 'origin', remote]);
      execFileSync('git', ['-C', root, 'push', '-q', '-u', 'origin', 'main']);
      // `identity`: the checkout itself names a commit identity, so commits succeed and only the push can fail.
      if (opts.identity) { execFileSync('git', ['-C', root, 'config', 'user.name', 'Example']); execFileSync('git', ['-C', root, 'config', 'user.email', 'example@example.invalid']); }
      await createSource(engine, backend, source, {}, root);
      const reviewed = async (operation: string) => ({ admin_intent: operation, expected_state: await writerAdminState(engine) });
      await runPersistenceAdministration(engine, 'writer_claim', { source_id: source, path: root, ...await reviewed('writer_claim') });
      await runPersistenceAdministration(engine, 'writer_git_durability', { source_id: source, enable: true, ...await reviewed('writer_git_durability') });
      try { return await run(home, root, written); } finally { await disposePersistenceConsumer(engine); }
    });
  } finally {
    target.requeueEffectRow = requeue;
    target.parkEffectRow = park;
    rmSync(home, { recursive: true, force: true });
  }
}

type GitRow = { state: string; error_code?: string | null };
/** How long `slowPushRecord` holds a failed push's requeue write; far longer than 20 effect passes take. */
const SLOW_PUSH_RECORD_MS = 3_000;

/**
 * Effect passes until the Git effect is out of `running` and `until` holds, bounded by `timeoutMs`; the row it saw.
 * A row another worker claimed (the process's own background consumer, which submitPageMutation starts) is `running`
 * until that worker records the attempt, and a pass in that time finds nothing to claim, so this waits instead of
 * counting passes. Past the deadline it fails, naming what it waited for and the last state and code it read.
 */
async function drainGit<R extends GitRow>(engine: BrainEngine, git: () => Promise<R>, until: (row: R) => boolean, what: string,
  timeoutMs = 60_000): Promise<R> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await git();
    if (row.state !== 'running' && until(row)) return row;
    if (Date.now() > deadline) {
      throw new Error(`the Git effect did not reach ${what} within ${timeoutMs} ms; last state ${row.state} (${row.error_code ?? 'no code'})`);
    }
    if (row.state !== 'running') await runPersistenceEffects(engine, { engine: engine.kind } as never, { hostId: hostIdFor(engine), limit: 20 });
    await Bun.sleep(25);
  }
}

/**
 * Starts one effect pass without waiting for it and returns once the Git effect is claimed (`running`, by that pass or
 * by the background consumer): the race the flaky drain lost, made certain. The caller awaits the returned pass (it
 * is wrapped, because an async function that returned it bare would wait for it).
 */
async function claimedGit(engine: BrainEngine, git: () => Promise<GitRow>, timeoutMs = 30_000): Promise<{ pass: Promise<number> }> {
  const pass = runPersistenceEffects(engine, { engine: engine.kind } as never, { hostId: hostIdFor(engine), limit: 20 });
  const deadline = Date.now() + timeoutMs;
  for (let row = await git(); row.state !== 'running'; row = await git()) {
    if (Date.now() > deadline) { await pass; throw new Error(`the Git effect was not claimed within ${timeoutMs} ms; last state ${row.state}`); }
    await Bun.sleep(5);
  }
  return { pass };
}

/** One put_page, then effect passes until its Git effect parks; what each failed attempt wrote. */
async function writeUntilParked(engine: BrainEngine, written: Written[], slug = 'notes/ivy-example', source = 'work') {
  const from = written.length;
  const request_id = randomUUID();
  await submitPageMutation(ctxFor(engine, source) as never, { operation: 'put_page',
    params: { slug, content: '---\ntype: note\ntitle: Ivy Example\n---\nWorks at widget-co.\n', request_id } });
  const row = (await engine.readWriteRequest('local_cli', (await readLocalWriter(engine, 'cli')).id, request_id))!;
  const git = async () => (await engine.readRequestEffects(row.id, 'git'))[0]!;
  await drainGit(engine, git, row => row.state === 'failed', 'parked (failed)');
  const attempts = written.slice(from).filter(w => w.kind === 'park' || w.reason === 'git_unavailable').map(w => ({
    kind: w.kind, reason: w.reason, failures: w.data.target_failures ?? null,
    last_error: w.data.last_error ?? w.data.parked?.[0]?.last_error ?? null, parked: w.data.parked?.map((p: { error_code: string }) => p.error_code) ?? null }));
  const e = await git();
  return { git, attempts, request: row.state, effect: { state: e.state, code: e.error_code } };
}

/** Sync status as the CLI prints it: `--json` and text, with the scratch home and timestamps written as placeholders. */
async function syncStatusOutput(engine: BrainEngine, home: string, source = 'work') {
  const norm = (text: string) => text.split(home).join('<home>').replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, '<time>');
  const capture = async (args: string[]) => {
    const lines: string[] = [];
    const log = console.log, write = process.stdout.write.bind(process.stdout);
    console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
    process.stdout.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stdout.write;
    try { await runSyncStatus(engine, ['--source', source, ...args]); } finally { console.log = log; process.stdout.write = write; }
    return lines.join('\n');
  };
  const json = JSON.parse(await capture(['--json'])) as Record<string, unknown>;
  const text = norm(await capture([]));
  const picked = JSON.parse(norm(JSON.stringify({ git_commit_holds: json.git_commit_holds, git_push_holds: json.git_push_holds, next: json.next,
    needs_human: json.needs_human, human_reason: json.human_reason, needs_human_from: json.needs_human_from })));
  const lines = text.split('\n').filter(line => /git commits held|git effects blocked|^\s+fix: |ASK THE USER|check \(read-only\)|Next:|holds nothing/.test(line));
  return { json: picked, lines, text };
}

describe('engine parity: a managed Git commit that cannot be made is loud in gbrain sync status', () => {
  parityTest('no Git identity: requeued with its step, parked after 5, listed by writer status, doctor and sync status; the identity fix commits it; a leaky clean filter stores and prints no secret', {
    methods: ['worktreeClaimStore', 'readRequestEffects', 'requeueEffectRow', 'parkEffectRow', 'listGitPushHoldRows', 'readSyncStatusCommittedRow'],
    timeout: 180_000,
  }, async (engine, backend) => withNoIdentityCheckout(engine, backend, {}, async (home, root, written) => {
    const { git, attempts, request, effect } = await writeUntilParked(engine, written);
    const tracked = () => execFileSync('git', ['-C', root, 'ls-files', 'notes/ivy-example.md'], { encoding: 'utf8' }).trim();
    const writer = await runPersistenceAdministration(engine, 'writer_status', { source_id: 'work' });
    const doctor = await checkParkedEffects(engine, ['work']);
    const status = await syncStatusOutput(engine, home);
    const hold = (status.json.git_commit_holds as Array<Record<string, unknown>>)[0];
    const out = {
      request, effect, attempts, tracked: tracked(),
      writer_lists_it: JSON.stringify(writer).includes('git_unavailable'),
      doctor: { status: doctor.status, lists_it: JSON.stringify(doctor).includes('git_unavailable') },
      // Strings, so the arms compare byte for byte (deep equality would ignore key order).
      sync_json: JSON.stringify(status.json), lines: status.lines.join('\n'), holds_nothing: status.text.includes('holds nothing'),
    };
    expect(request).toBe('committed');
    expect(attempts.length).toBe(5);
    expect(attempts.map(a => [a.kind, a.failures, a.parked])).toEqual([['requeue', 1, null], ['requeue', 2, null], ['requeue', 3, null], ['requeue', 4, null], ['park', null, ['git_unavailable']]]);
    expect(effect).toEqual({ state: 'failed', code: 'targets_parked' });
    // F2 first: the identity question is the next step and sync status says a person must answer it.
    const next = status.json.next as Record<string, unknown>;
    expect(String(next.docs)).toContain('docs/guides/concurrent-writes.md#managed-git-identity');
    expect({ next: next.next, actor: next.actor }).toEqual({ next: 'ask_user', actor: 'user' });
    expect({ needs_human: status.json.needs_human, from: status.json.needs_human_from, reason: status.json.human_reason })
      .toEqual({ needs_human: true, from: { kind: 'git_commit', code: 'git_unavailable', root: '<home>/checkout' }, reason: next.user_message });
    const identityError = { phase: 'commit', step: 'commit-tree', reason: 'identity_missing', identity: true };
    expect(attempts.map(a => a.last_error)).toEqual(Array(5).fill(identityError));
    expect(out.tracked).toBe('');
    expect(out.writer_lists_it).toBe(true);
    expect(out.doctor.lists_it).toBe(true);
    expect(hold).toMatchObject({ source_id: 'work', retrying: 0, parked: 1, codes: ['git_unavailable'], former_worktree: false, identity_missing: true,
      owner_host: 'this_host', root: '<home>/checkout' });
    expect(hold!.last_error).toEqual(identityError);
    expect(status.lines.some(line => line.includes('ASK THE USER: Git cannot commit page files in <home>/checkout'))).toBe(true);
    // F2-02: the question prints once, on its hold; Next points at it instead of repeating it.
    expect(status.text.split(String(next.user_message)).length - 1).toBe(1);
    expect(status.text).toContain('\n  ASK THE USER first: the question on the hold above.');
    expect(status.json.git_push_holds).toEqual([]);
    expect(status.lines.some(line => line.includes('git commits held: 0 retrying, 1 parked (git_unavailable)')
      && line.includes('at step commit-tree (reason: identity_missing)'))).toBe(true);
    expect(out.holds_nothing).toBe(false);

    // The documented fix: the checkout's identity, then one more attempt for the parked effect.
    execFileSync('git', ['-C', root, 'config', 'user.name', 'Example']);
    execFileSync('git', ['-C', root, 'config', 'user.email', 'example@example.invalid']);
    await runPersistenceAdministration(engine, 'writer_retry_effects', { source_id: 'work', parked_code: 'git_unavailable' });
    await drainGit(engine, git, row => row.state === 'committed', 'committed');
    const after = await syncStatusOutput(engine, home);
    const fixed = { state: (await git()).state, tracked: tracked(), holds: after.json.git_commit_holds, sync_json: JSON.stringify(after.json), lines: after.lines.join('\n') };
    expect(fixed).toMatchObject({ state: 'committed', tracked: 'notes/ivy-example.md', holds: [] });
    expect((await readSyncStatus(engine, 'work')).git_commit_holds).toEqual([]);

    // A clean filter that prints a token-bearing remote URL and an Authorization header, then fails: only the add step
    // and its reason code are kept; none of git's words (no secret, no URL) reach the stored effect, the JSON or the text.
    const script = join(home, 'leaky-filter.sh');
    writeFileSync(script, `#!/bin/sh\necho ${JSON.stringify(`fatal: cannot reach ${SECRET_URL} ${SECRET_HEADER}`)} >&2\nexit 1\n`, { mode: 0o755 });
    execFileSync('git', ['-C', root, 'config', 'filter.leaky.clean', script]);
    execFileSync('git', ['-C', root, 'config', 'filter.leaky.required', 'true']);
    writeFileSync(join(root, '.git', 'info', 'attributes'), 'notes/leak-example.md filter=leaky\n');
    const from = written.length;
    const leak = await writeUntilParked(engine, written, 'notes/leak-example');
    const stored = JSON.stringify(written.slice(from));
    const leakStatus = await syncStatusOutput(engine, home);
    const printed = JSON.stringify(leakStatus.json) + leakStatus.text;
    const secrets = ['hunter2tokenvalue', 'qq9secretquerytoken', 'zz8secretbearervalue', 'alice-example:', 'git.example.invalid', 'cannot reach'];
    const leakHold = (leakStatus.json.git_commit_holds as Array<{ last_error: Record<string, unknown> | null }>)[0];
    const sanitized = {
      leaked: secrets.filter(secret => stored.includes(secret) || printed.includes(secret)),
      effect: leak.effect, last_error: leakHold?.last_error ?? null,
      sync_json: JSON.stringify(leakStatus.json), lines: leakStatus.lines.join('\n'),
    };
    expect(sanitized.leaked).toEqual([]);
    const filterError = { phase: 'commit', step: 'add', reason: 'filter_failed' };
    expect(sanitized.last_error).toEqual(filterError);
    expect(leak.attempts.map(a => a.last_error)).toEqual(Array(5).fill(filterError));
    expect(stored).not.toContain('"line"');
    return { ...out, fixed, sanitized };
  }));

  parityTest('sync status prints the same commit hold on every engine (on Rust, lane 7\'s recovery probe stood in by name)', {
    methods: ['worktreeClaimStore', 'readRequestEffects', 'requeueEffectRow', 'parkEffectRow', 'listGitPushHoldRows', 'readSyncStatusCommittedRow'],
    timeout: 120_000,
  }, async (engine, backend) => withNoIdentityCheckout(engine, backend, { source: 'seeded' }, async (home, _root, written) => {
    // effectRecoverySeam answers recordFailure's recovery probe as lane 7's typed effectRecovering will (no recovery
    // record here), so the Rust arm records the failure; PGLite and Postgres keep their raw read.
    if (backend === 'rust') effectRecoverySeam.probe = async () => false;
    try {
      const { attempts, effect } = await writeUntilParked(engine, written, 'notes/jade-example', 'seeded');
      expect(attempts.map(a => a.kind)).toEqual(['requeue', 'requeue', 'requeue', 'requeue', 'park']);
      expect(effect).toEqual({ state: 'failed', code: 'targets_parked' });
      const status = await syncStatusOutput(engine, home, 'seeded');
      const hold = (status.json.git_commit_holds as Array<Record<string, unknown>>)[0];
      expect(hold).toMatchObject({ source_id: 'seeded', retrying: 0, parked: 1, codes: ['git_unavailable'], identity_missing: true, owner_host: 'this_host' });
      expect(hold!.last_error).toEqual({ phase: 'commit', step: 'commit-tree', reason: 'identity_missing', identity: true });
      expect(status.json.needs_human).toBe(true);
      expect(status.json.git_push_holds).toEqual([]);
      expect(status.text).not.toContain('holds nothing');
      return { sync_json: JSON.stringify(status.json), lines: status.lines.join('\n') };
    } finally { effectRecoverySeam.probe = null; }
  }));

  parityTest('F1: a put whose push fails is a push hold that names its step and reason, and it pushes once the remote is back even with its tracking ref pruned (Rust: recovery probe seamed)', {
    methods: ['worktreeClaimStore', 'readRequestEffects', 'requeueEffectRow', 'listGitPushHoldRows', 'readSyncStatusCommittedRow'],
    timeout: 120_000,
  }, async (engine, backend) => withNoIdentityCheckout(engine, backend, { source: 'pushheld', identity: true, slowPushRecord: true }, async (home, root) => {
    // F1 on every arm: put_page is Rust-servable, so this case runs on Rust (seamed below), unlike the removal case.
    // SEAMED on Rust: the failed push's recordFailure runs lane 7's recovery probe (raw SQL until 20da396ebd lands,
    // conflict row 55a), so effectRecoverySeam answers "no recovery record" there; PGLite and Postgres keep their raw read.
    if (backend === 'rust') effectRecoverySeam.probe = async () => false;
    const tip = (ref: string) => execFileSync('git', ['-C', ref === 'remote' ? join(home, 'remote.git') : root, 'rev-parse', ref === 'remote' ? 'main' : 'HEAD'], { encoding: 'utf8' }).trim();
    const submit = async (operation: 'put_page' | 'delete_page', params: Record<string, unknown>) => {
      const request_id = randomUUID();
      await submitPageMutation(ctxFor(engine, 'pushheld') as never, { operation, params: { ...params, request_id } });
      const row = (await engine.readWriteRequest('local_cli', (await readLocalWriter(engine, 'cli')).id, request_id))!;
      return async () => (await engine.readRequestEffects(row.id, 'git'))[0]!;
    };
    try {
      const put = await submit('put_page', { slug: 'notes/lee-example', content: '---\ntype: note\ntitle: Lee Example\n---\nWorks at widget-co.\n' });
      await drainGit(engine, put, row => row.state === 'committed', 'committed');
      expect(tip('remote')).toBe(tip('HEAD'));
      execFileSync('git', ['-C', root, 'remote', 'set-url', 'origin', join(home, 'no-such-remote.git')]);
      const removal = await submit('put_page', { slug: 'notes/mia-example', content: '---\ntype: note\ntitle: Mia Example\n---\nWorks at acme-example.\n' });
      // The first failed push is still being recorded (claimed, running) while the drain starts: slowPushRecord holds it.
      const inflight = await claimedGit(engine, removal);
      const held = await drainGit(engine, removal, row => row.state === 'queued' && !!row.error_code, 'a queued push hold');
      await inflight.pass;
      expect({ state: held.state, code: held.error_code }).toEqual({ state: 'queued', code: 'git_push_unavailable' });
      const status = await syncStatusOutput(engine, home, 'pushheld');
      const hold = (status.json.git_push_holds as Array<Record<string, unknown>>)[0]!;
      expect({ codes: hold.codes, last_error: hold.last_error }).toEqual({ codes: ['git_push_unavailable'], last_error: { phase: 'push', step: 'ls-remote', reason: 'remote_unreachable' } });
      expect(status.text).toContain('(git_push_unavailable) since <time> at step ls-remote (reason: remote_unreachable)');
      execFileSync('git', ['-C', root, 'remote', 'set-url', 'origin', join(home, 'remote.git')]);
      execFileSync('git', ['-C', root, 'update-ref', '-d', 'refs/remotes/origin/main']);
      expect(tip('remote')).not.toBe(tip('HEAD'));
      const done = await drainGit(engine, removal, row => row.state === 'committed', 'committed');
      expect({ state: done.state, push: (done.outcome as Record<string, unknown>).push }).toEqual({ state: 'committed', push: 'committed' });
      expect(tip('remote')).toBe(tip('HEAD'));
      return { held: { state: held.state, code: held.error_code }, hold: JSON.stringify(hold), done: JSON.stringify(done.outcome) };
    } finally { effectRecoverySeam.probe = null; }
  }));

  parityTest('GCH-03a + F1: a removal whose push failed, retried after its tracking ref was pruned, pushes; the push hold names its step and reason (Rust: stops at delete_page preparation)', {
    methods: ['worktreeClaimStore', 'readRequestEffects', 'requeueEffectRow', 'listGitPushHoldRows', 'readSyncStatusCommittedRow'],
    timeout: 120_000,
  }, async (engine, backend) => withNoIdentityCheckout(engine, backend, { source: 'pruned', identity: true, slowPushRecord: true }, async (home, root) => {
    // STOPPED on Rust: delete_page's preparation reads live file claimants with raw SQL (file-claims.ts
    // findLiveFileClaimants, via page-prepare.ts prepareFileTarget), the page-prepare item due 2026-12-10, so the Rust arm
    // stops on executeRaw before any Git step; the F1 case above carries the push-hold evidence on Rust.
    // SEAMED on Rust: the failed push's recordFailure runs lane 7's recovery probe (raw SQL until 20da396ebd lands,
    // conflict row 55a), so effectRecoverySeam answers "no recovery record" there; PGLite and Postgres keep their raw read.
    if (backend === 'rust') effectRecoverySeam.probe = async () => false;
    const tip = (ref: string) => execFileSync('git', ['-C', ref === 'remote' ? join(home, 'remote.git') : root, 'rev-parse', ref === 'remote' ? 'main' : 'HEAD'], { encoding: 'utf8' }).trim();
    const submit = async (operation: 'put_page' | 'delete_page', params: Record<string, unknown>) => {
      const request_id = randomUUID();
      await submitPageMutation(ctxFor(engine, 'pruned') as never, { operation, params: { ...params, request_id } });
      const row = (await engine.readWriteRequest('local_cli', (await readLocalWriter(engine, 'cli')).id, request_id))!;
      return async () => (await engine.readRequestEffects(row.id, 'git'))[0]!;
    };
    try {
      const put = await submit('put_page', { slug: 'notes/lee-example', content: '---\ntype: note\ntitle: Lee Example\n---\nWorks at widget-co.\n' });
      await drainGit(engine, put, row => row.state === 'committed', 'committed');
      expect(tip('remote')).toBe(tip('HEAD'));
      execFileSync('git', ['-C', root, 'remote', 'set-url', 'origin', join(home, 'no-such-remote.git')]);
      const page = await engine.readPageSnapshot('notes/lee-example', { sourceId: 'pruned', includeDeleted: true });
      const removal = await submit('delete_page', { slug: 'notes/lee-example', expected_revision: page!.revision });
      // The first failed push is still being recorded (claimed, running) while the drain starts: slowPushRecord holds it.
      const inflight = await claimedGit(engine, removal);
      const held = await drainGit(engine, removal, row => row.state === 'queued' && !!row.error_code, 'a queued push hold');
      await inflight.pass;
      expect({ state: held.state, code: held.error_code }).toEqual({ state: 'queued', code: 'git_push_unavailable' });
      const status = await syncStatusOutput(engine, home, 'pruned');
      const hold = (status.json.git_push_holds as Array<Record<string, unknown>>)[0]!;
      expect({ codes: hold.codes, last_error: hold.last_error }).toEqual({ codes: ['git_push_unavailable'], last_error: { phase: 'push', step: 'ls-remote', reason: 'remote_unreachable' } });
      expect(status.text).toContain('(git_push_unavailable) since <time> at step ls-remote (reason: remote_unreachable)');
      execFileSync('git', ['-C', root, 'remote', 'set-url', 'origin', join(home, 'remote.git')]);
      execFileSync('git', ['-C', root, 'update-ref', '-d', 'refs/remotes/origin/main']);
      expect(tip('remote')).not.toBe(tip('HEAD'));
      const done = await drainGit(engine, removal, row => row.state === 'committed', 'committed');
      expect({ state: done.state, outcome: done.outcome }).toEqual({ state: 'committed', outcome: { git: 'skipped', reason: 'target_absent', push: 'committed' } });
      expect(tip('remote')).toBe(tip('HEAD'));
      return { held: { state: held.state, code: held.error_code }, hold: JSON.stringify(hold), done: JSON.stringify(done.outcome) };
    } finally { effectRecoverySeam.probe = null; }
  }));

  parityTest('F2a: a commit hold that asks the user still sets needs_human while a recovery record is the next step, and the text and JSON agree', {
    methods: ['worktreeClaimStore', 'readRequestEffects', 'requeueEffectRow', 'parkEffectRow', 'listGitPushHoldRows', 'readSyncStatusCommittedRow', 'readSyncRecoveryProbeRow'],
    timeout: 120_000,
  }, async (engine, backend) => withNoIdentityCheckout(engine, backend, { source: 'pending' }, async (home, _root, written) => {
    if (backend === 'rust') effectRecoverySeam.probe = async () => false;
    const target = engine as unknown as Record<string, unknown>;
    const probe = engine.readSyncRecoveryProbeRow.bind(engine);
    try {
      const { effect } = await writeUntilParked(engine, written, 'notes/kai-example', 'pending');
      expect(effect).toEqual({ state: 'failed', code: 'targets_parked' });
      // The seam: the recovery probe reports one request still holding a publication recovery record, so the recovery
      // step is \`next\` (it outranks the commit hold's question) while the identity hold is still listed.
      target.readSyncRecoveryProbeRow = async () => ({ n: 1, request_id: '00000000-0000-4000-8000-000000000001', slug: 'notes/kai-example', blocked: false });
      const status = await syncStatusOutput(engine, home, 'pending');
      const hold = (status.json.git_commit_holds as Array<{ fix: { next?: string; user_message?: string } }>)[0]!;
      const next = status.json.next as { next?: string; user_message?: string };
      expect(next.next).toBe('run');
      expect(hold.fix.next).toBe('ask_user');
      expect(next.user_message).not.toBe(hold.fix.user_message);
      expect(status.text).toContain('ASK THE USER: Git cannot commit page files in <home>/checkout');
      expect({ needs_human: status.json.needs_human, from: status.json.needs_human_from, reason: status.json.human_reason })
        .toEqual({ needs_human: true, from: { kind: 'git_commit', code: 'git_unavailable', root: '<home>/checkout' }, reason: hold.fix.user_message });
      return { sync_json: JSON.stringify(status.json), lines: status.lines.join('\n') };
    } finally { target.readSyncRecoveryProbeRow = probe; effectRecoverySeam.probe = null; }
  }));
});
