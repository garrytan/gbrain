/**
 * Engine parity: a managed Git commit that cannot be made is loud in `gbrain sync status` (git_commit_holds).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on a host with no Git identity, a bound put_page commits the page; its Git effect fails `git_unavailable`
 *    at the commit step and keeps the step and git's sanitized first stderr line (`last_error`); attempts 1-4 requeue,
 *    attempt 5 parks (PARK_AFTER_FAILURES); writer status and doctor parked_effects list it; `gbrain sync status` JSON
 *    carries `git_commit_holds` with the step, the line and `identity_missing`, its `next` is the identity fix, and the
 *    text names the hold and never says "holds nothing". Setting the checkout's identity and the documented retry then
 *    commits the file and clears the hold. A clean filter that prints a token-bearing URL and an Authorization header
 *    leaves no secret in the stored effect, the JSON or the text. PGLite, Postgres and Rust print the same bytes.
 *  - Regression: the hold missing from sync status (git_unavailable not read there), the step or line lost, a secret
 *    stored or printed, a Rust sync status that never reads Git holds, or the arms printing different output.
 *  - Why existing coverage misses it: managed-git-missing-identity.test.ts pins the park on PGLite only and reads no
 *    sync status; no test fed a secret through a git step's stderr.
 *  - Rust: the failure record's recovery probe (persistence/effects.ts recordFailure) is raw SQL, so on a Rust brain
 *    (single-host and multi-user) the lifecycle case stops on a typed raw_sql refusal at the first failed attempt
 *    (docs/designs/RUST_ENGINE.md conflict row 55). WAITING: it must run equal on the Rust arms once lane 7's typed
 *    effectRecovering (20da396ebd) reaches rust-engine/multiuser (it rides rust-engine/managed-on-rust-2b to main), and
 *    before multi-user mode turns on by default. Until then the second case proves the output on every arm: on Rust it
 *    stands lane 7's probe in by name (effects.ts effectRecoverySeam, answering "no recovery record"), and the arms
 *    compare the sync status bytes.
 *  - Seams: retries come due at once (requeueEffectRow with delayMs 0, a typed member every arm serves). Real engines,
 *    real Git checkouts.
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

async function withNoIdentityCheckout<T>(engine: BrainEngine, backend: ParityBackend, opts: { source?: string },
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

/** One put_page, then effect passes until its Git effect parks; what each failed attempt wrote. */
async function writeUntilParked(engine: BrainEngine, written: Written[], slug = 'notes/ivy-example', source = 'work') {
  const from = written.length;
  const request_id = randomUUID();
  await submitPageMutation(ctxFor(engine, source) as never, { operation: 'put_page',
    params: { slug, content: '---\ntype: note\ntitle: Ivy Example\n---\nWorks at widget-co.\n', request_id } });
  const row = (await engine.readWriteRequest('local_cli', (await readLocalWriter(engine, 'cli')).id, request_id))!;
  const git = async () => (await engine.readRequestEffects(row.id, 'git'))[0]!;
  for (let i = 0; i < 60 && (await git()).state !== 'failed'; i++) {
    await runPersistenceEffects(engine, { engine: engine.kind } as never, { hostId: hostIdFor(engine), limit: 20 });
    await Bun.sleep(50);
  }
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
  const picked = JSON.parse(norm(JSON.stringify({ git_commit_holds: json.git_commit_holds, git_push_holds: json.git_push_holds, next: json.next })));
  const lines = text.split('\n').filter(line => /git commits not made|git effects blocked|^\s+fix: |Next:|holds nothing/.test(line));
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
    const last = attempts[4]!.last_error;
    expect({ phase: last.phase, step: last.step, identity: last.identity }).toEqual({ phase: 'commit', step: 'commit-tree', identity: true });
    expect(out.tracked).toBe('');
    expect(out.writer_lists_it).toBe(true);
    expect(out.doctor.lists_it).toBe(true);
    expect(hold).toMatchObject({ source_id: 'work', retrying: 0, parked: 1, codes: ['git_unavailable'], former_worktree: false, identity_missing: true,
      last_error: { phase: 'commit', step: 'commit-tree', identity: true } });
    expect(String((status.json.next as Record<string, unknown>).docs)).toContain('docs/guides/concurrent-writes.md#managed-git-identity');
    expect(status.json.git_push_holds).toEqual([]);
    expect(status.lines.some(line => line.includes('git commits not made: 0 retrying, 1 parked (git_unavailable)') && line.includes('at step commit-tree'))).toBe(true);
    expect(out.holds_nothing).toBe(false);

    // The documented fix: the checkout's identity, then one more attempt for the parked effect.
    execFileSync('git', ['-C', root, 'config', 'user.name', 'Example']);
    execFileSync('git', ['-C', root, 'config', 'user.email', 'example@example.invalid']);
    await runPersistenceAdministration(engine, 'writer_retry_effects', { source_id: 'work', parked_code: 'git_unavailable' });
    for (let i = 0; i < 20 && (await git()).state !== 'committed'; i++) {
      await runPersistenceEffects(engine, { engine: engine.kind } as never, { hostId: hostIdFor(engine), limit: 20 });
    }
    const after = await syncStatusOutput(engine, home);
    const fixed = { state: (await git()).state, tracked: tracked(), holds: after.json.git_commit_holds, sync_json: JSON.stringify(after.json), lines: after.lines.join('\n') };
    expect(fixed).toMatchObject({ state: 'committed', tracked: 'notes/ivy-example.md', holds: [] });
    expect((await readSyncStatus(engine, 'work')).git_commit_holds).toEqual([]);

    // A clean filter that prints a token-bearing remote URL and an Authorization header, then fails: the add step's
    // line is kept, and no secret reaches the stored effect, the JSON or the text.
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
    const secrets = ['hunter2tokenvalue', 'qq9secretquerytoken', 'zz8secretbearervalue', 'alice-example:'];
    const leakHold = (leakStatus.json.git_commit_holds as Array<{ last_error: { line: string } | null }>)[0];
    const sanitized = {
      leaked: secrets.filter(secret => stored.includes(secret) || printed.includes(secret)),
      effect: leak.effect, last_error: leakHold?.last_error ?? null,
      sync_json: JSON.stringify(leakStatus.json), lines: leakStatus.lines.join('\n'),
    };
    expect(sanitized.leaked).toEqual([]);
    expect(stored).toContain('git.example.invalid/acme.git');
    expect(sanitized.last_error).toMatchObject({ phase: 'commit', step: 'add' });
    expect(String(sanitized.last_error?.line)).toContain('https://git.example.invalid/acme.git');
    expect(String(sanitized.last_error?.line)).toContain('<REDACTED>');
    expect(JSON.stringify(sanitized.last_error)).not.toContain('identity');
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
      expect(hold).toMatchObject({ source_id: 'seeded', retrying: 0, parked: 1, codes: ['git_unavailable'], identity_missing: true,
        last_error: { phase: 'commit', step: 'commit-tree', line: 'Author identity unknown', identity: true } });
      expect(status.json.git_push_holds).toEqual([]);
      expect(status.text).not.toContain('holds nothing');
      return { sync_json: JSON.stringify(status.json), lines: status.lines.join('\n') };
    } finally { effectRecoverySeam.probe = null; }
  }));
});
