/**
 * `gbrain migrate` engine graduation CLI (plan §7, DX amendments): routing,
 * flag parsing, the exit-3 consent payload, `--plan`, the run, run-scoped
 * verbs, `--discard-source` (dry run, exit-3 consent, the approved delete),
 * the exit-code map (0/1/2/3/11/75/130) and secret hygiene, over a
 * fake orchestrator (the G2a module is exercised by its own lane's tests).
 * Serial: it points GBRAIN_HOME at a temp dir and reads the file-plane
 * opt-out from it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import { opError } from '../src/core/ops/contract.ts';
import { renderCliError } from '../src/core/agent-output.ts';
import type { ProgressReporter } from '../src/core/progress.ts';
import type {
  GraduationCommandOptions, GraduationPlan, GraduationReceipt, GraduationStatusDoc,
} from '../src/core/persistence/engine-graduation.types.ts';
import type { DiscardOptions, DiscardPlan } from '../src/core/persistence/graduation-discard.ts';
import { drainTimeoutError, inProgressError, interruptedError } from '../src/core/persistence/graduation-errors.ts';
import {
  parseGraduationArgs, routesToGraduation, runMigrateGraduation, type GraduationApi,
} from '../src/commands/migrate-graduation.ts';

const SECRET_URL = 'postgresql://alice:s3cret-pw@db.acme-example.test:5432/brain';
let home: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-grad-cli-'));
  mkdirSync(join(home, '.gbrain'));
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: join(home, 'brain.pglite') }));
});
afterAll(() => { rmSync(home, { recursive: true, force: true }); });

const plan: GraduationPlan = {
  planHash: 'ph_0123456789abcdef01234567',
  source: { dataDir: '/home/alice-example/.gbrain/brain.pglite', brainId: 'brain-1', hostId: 'host-1' },
  target: { id: 'tid', host: 'db.acme-example.test', port: 5432, database: 'brain', user: 'alice' },
  routes: { main: 'postgresql://alice:***@db.acme-example.test:5432/brain', ddl: 'postgresql://alice:***@db.acme-example.test:5432/brain', urlEnv: 'GBRAIN_TARGET_URL' },
  triggerBypass: 'session_replication_role',
  tables: [{ relation: 'pages', class: 'carry', rows: 10, bytes: 100 }, { relation: 'query_cache', class: 'rebuild', rows: 3, bytes: 1 }],
  blockers: [],
  estimateSeconds: { copy: 1, verify: 1, doctor: 2, total: 4 },
  sourceMeasured: 'now',
  nextArgv: [],
};
const receipt: GraduationReceipt = {
  runId: 'run-1', state: 'authoritative', tables: [{ relation: 'pages', rows: 10, rootSha256: 'x', batches: [] }],
  triggerBypass: 'session_replication_role', replay: { status: 'passed', requestId: 'r1' }, timings: { copy: 1000 },
  targetDisplayUrl: 'postgresql://alice:***@db.acme-example.test:5432/brain', retainedPath: '/home/alice-example/.gbrain/brain.pglite.graduated-run-1',
  serveHandoff: true, doctor: { source: [], target: [] },
};
const discardPlan: DiscardPlan = {
  planHash: 'dh_0123456789abcdef', runId: 'run-1', dataDir: '/home/alice-example/.gbrain/brain.pglite', target: plan.routes.main,
  paths: [
    { kind: 'retained_copy', path: '/home/alice-example/.gbrain/brain.pglite.graduated-run-1', bytes: 47 * 1024 * 1024, sizeIncomplete: false },
    { kind: 'tombstone', path: '/home/alice-example/.gbrain/brain.pglite', bytes: 680, sizeIncomplete: false },
    { kind: 'intent_marker', path: '/home/alice-example/.gbrain/brain.pglite.gbrain-graduation.json', bytes: 393, sizeIncomplete: false },
  ],
  sourceDiscardedAt: null,
};
const statusDoc: GraduationStatusDoc = {
  schema_version: 1, state: 'copying', runId: 'run-1', to: 'postgres', source: plan.source, sourcePath: null,
  target: { identity: plan.target, displayUrl: plan.routes.main, row: 'copying', reachable: true }, receipt: null,
  liveRun: { pid: 123 }, tables: [], nextArgv: ['gbrain', 'migrate', '--status', '--json'],
};

type Call = { fn: string; opts?: Partial<GraduationCommandOptions> & DiscardOptions };
function fakeApi(over: Partial<GraduationApi> = {}): GraduationApi & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    planGraduation: async (opts) => { calls.push({ fn: 'plan', opts }); return plan; },
    runGraduation: async (opts) => { calls.push({ fn: 'run', opts }); return receipt; },
    graduationStatus: async () => { calls.push({ fn: 'status' }); return statusDoc; },
    resumeGraduation: async (opts) => { calls.push({ fn: 'resume', opts }); return receipt; },
    rollbackGraduation: async (opts) => { calls.push({ fn: 'rollback', opts }); return { state: 'abandoned', restoredPath: null, dropped: [] }; },
    planDiscardSource: async () => { calls.push({ fn: 'discard_plan' }); return discardPlan; },
    discardSource: async (opts) => {
      calls.push({ fn: 'discard', opts });
      return { runId: 'run-1', target: plan.routes.main, sourceDiscardedAt: '2026-10-05T00:00:00.000Z', deleted: discardPlan.paths };
    },
    ...over,
  };
}

const silentProgress: ProgressReporter = { start() {}, tick() {}, heartbeat() {}, finish() {}, child() { return silentProgress; } };

async function run(args: string[], api = fakeApi(), extra: { env?: NodeJS.ProcessEnv; signal?: AbortSignal; stdin?: string } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const realStdout = process.stdout.write.bind(process.stdout);
  const realStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((s: string) => { out.push(String(s)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => { err.push(String(s)); return true; }) as typeof process.stderr.write;
  try {
    const code = await withEnv({ GBRAIN_HOME: home }, () => runMigrateGraduation(args, {
      api, env: extra.env ?? { GBRAIN_TARGET_URL: SECRET_URL }, out: t => { out.push(t); }, err: t => { err.push(t); },
      progress: silentProgress, signal: extra.signal ?? new AbortController().signal,
      writeError: (e, o) => {
        const r = renderCliError(e, { json: o.json, command: 'migrate', tty: false });
        if (r.stdout) out.push(JSON.stringify({ ...(o.legacy ?? {}), ...JSON.parse(r.stdout) }));
        if (r.stderr) err.push(r.stderr);
        return r.exitCode;
      },
      ...(extra.stdin !== undefined ? { readStdin: async () => extra.stdin! } : {}),
    }));
    return { code, stdout: out.join(''), stderr: err.join(''), api };
  } finally {
    process.stdout.write = realStdout;
    process.stderr.write = realStderr;
  }
}

describe('routing', () => {
  const pglite = { engine: 'pglite' as const, database_path: '/x/brain.pglite' };
  test('PGLite --to postgres|supabase routes to graduation; other forms fall through', () => {
    expect(routesToGraduation(['--to', 'postgres', '--url-env', 'X'], pglite, 'linux')).toBe(true);
    expect(routesToGraduation(['--to', 'supabase'], pglite, 'darwin')).toBe(true);
    expect(routesToGraduation(['--to=postgres'], pglite, 'linux')).toBe(true);
    expect(routesToGraduation(['--to', 'pglite'], { engine: 'postgres', database_url: 'postgresql://h/db' }, 'linux')).toBe(false);
    expect(routesToGraduation(['embeddings', '--to', 'openai:x'], pglite, 'linux')).toBe(false);
    expect(routesToGraduation(['--to', 'postgres', '--help'], pglite, 'linux')).toBe(false);
    expect(routesToGraduation(['--to', 'postgres'], { engine: 'postgres', database_url: 'postgresql://h/db' }, 'linux')).toBe(false);
  });
  test('opt-out and Windows keep the legacy copier for the bare run; run-scoped verbs always route', () => {
    expect(routesToGraduation(['--to', 'postgres'], { ...pglite, migrate: { graduation: false } }, 'linux')).toBe(false);
    expect(routesToGraduation(['--to', 'postgres'], pglite, 'win32')).toBe(false);
    for (const verb of ['--status', '--resume', '--rollback-to-source', '--discard-source', '--plan', '--dry-run']) {
      expect(routesToGraduation([verb], { ...pglite, migrate: { graduation: false } }, 'win32')).toBe(true);
    }
  });
});

describe('parseGraduationArgs', () => {
  test('modes, aliases and escape hatches', () => {
    expect(parseGraduationArgs(['--to', 'supabase', '--dry-run']).mode).toBe('plan');
    expect(parseGraduationArgs(['--status']).mode).toBe('status');
    const a = parseGraduationArgs(['--to', 'postgres', '--url-env', 'U', '--drain-timeout', '120', '--trigger-bypass', 'disable-trigger', '--batch-size', '500', '--yes', '--expect', 'ph_x']);
    expect(a).toMatchObject({ mode: 'run', to: 'postgres', urlEnv: 'U', drainTimeoutSec: 120, triggerBypass: 'disable_trigger', batchSize: 500, yes: true, expect: 'ph_x' });
    expect(parseGraduationArgs(['--to', 'postgres']).drainTimeoutSec).toBe(60);
    expect(parseGraduationArgs(['--to', 'postgres', '--url', '-']).urlFromStdin).toBe(true);
    expect(parseGraduationArgs(['--discard-source'])).toMatchObject({ mode: 'discard', dryRun: false });
    expect(parseGraduationArgs(['--discard-source', '--dry-run'])).toMatchObject({ mode: 'discard', dryRun: true });
    expect(parseGraduationArgs(['--discard-source', '--plan', '--yes', '--expect', 'dh_x'])).toMatchObject({ mode: 'discard', dryRun: true, yes: true, expect: 'dh_x' });
  });
  test.each([
    [['--plan', '--status']], [['--resume', '--rollback-to-source']], [['--to', 'mysql']], [['--to', 'pglite', '--plan']],
    [['--plan']], [['--to', 'postgres', '--url', 'u', '--url-env', 'V']], [['--to', 'postgres', '--drain-timeout', '0']],
    [['--to', 'postgres', '--trigger-bypass', 'off']], [['--status', '--yes']], [['--to', 'postgres', '--url']],
    [['--discard-source', '--status']], [['--discard-source', '--rollback-to-source']], [['--discard-source', '--to', 'postgres']],
    [['--discard-source', '--url-env', 'GBRAIN_TARGET_URL']], [['--discard-source', '--force']],
  ])('usage error %j', (args) => {
    let code: string | undefined;
    try { parseGraduationArgs(args); } catch (e) { code = (e as { code?: string }).code; }
    expect(code).toBe('invalid_params');
  });
});

describe('runMigrateGraduation', () => {
  test('bare run: exit 3 consent payload bound to the plan, never the password', async () => {
    const r = await run(['--to', 'supabase', '--url-env', 'GBRAIN_TARGET_URL', '--json']);
    expect(r.code).toBe(3);
    const doc = JSON.parse(r.stdout);
    expect(doc.code).toBe('confirmation_required');
    expect(doc.effects).toEqual(['egress', 'destructive']);
    expect(doc.plan_hash).toBe(plan.planHash);
    expect(doc.fix.argv).toEqual(['gbrain', 'migrate', '--to', 'supabase', '--url-env', 'GBRAIN_TARGET_URL', '--yes', '--expect', plan.planHash]);
    expect(doc.fix.next).toBe('ask_user');
    expect(doc.preview.argv).toEqual(['gbrain', 'migrate', '--to', 'supabase', '--url-env', 'GBRAIN_TARGET_URL', '--plan', '--json']);
    expect(doc.user_message).toContain('db.acme-example.test');
    expect(doc.what_moves.length).toBeGreaterThan(0);
    expect(doc.what_stays.join(' ')).toContain('graduated');
    expect(r.api.calls.map(c => c.fn)).toEqual(['plan']);
    expect(r.api.calls[0]!.opts).toMatchObject({ to: 'supabase', urlEnv: 'GBRAIN_TARGET_URL', drainTimeoutMs: 60_000, yes: false });
    expect(r.stdout + r.stderr).not.toContain('s3cret-pw');
  });

  test('--yes without --expect re-plans and refuses with the fresh hash; --expect alone on a changed plan is preview_changed', async () => {
    const yes = await run(['--to', 'postgres', '--url-env', 'GBRAIN_TARGET_URL', '--yes', '--json']);
    expect(yes.code).toBe(3);
    expect(JSON.parse(yes.stdout).fix.argv).toContain(plan.planHash);
    const stale = await run(['--to', 'postgres', '--url-env', 'GBRAIN_TARGET_URL', '--expect', 'ph_stale', '--json']);
    expect(stale.code).toBe(1);
    expect(JSON.parse(stale.stdout).code).toBe('preview_changed');
  });

  test('--force and escape hatches are echoed into the approved command', async () => {
    const r = await run(['--to', 'postgres', '--url-env', 'GBRAIN_TARGET_URL', '--force', '--batch-size', '200', '--json']);
    expect(r.code).toBe(3);
    expect(JSON.parse(r.stdout).fix.argv).toEqual(['gbrain', 'migrate', '--to', 'postgres', '--url-env', 'GBRAIN_TARGET_URL', '--batch-size', '200', '--force', '--yes', '--expect', plan.planHash]);
  });

  test('--plan: exit 0, one document with the plan and the next command', async () => {
    const r = await run(['--to', 'postgres', '--url-env', 'GBRAIN_TARGET_URL', '--plan', '--json']);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc).toMatchObject({ schema_version: 1, status: 'plan', plan: { planHash: plan.planHash } });
    expect(doc.next.command).toBe(`gbrain migrate --to postgres --url-env GBRAIN_TARGET_URL --yes --expect ${plan.planHash}`);
  });

  test('the approved run: receipt, retained copy, doctor, mcp expose, credentials and MCP restart notes', async () => {
    const r = await run(['--to', 'postgres', '--url-env', 'GBRAIN_TARGET_URL', '--yes', '--expect', plan.planHash, '--json']);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.status).toBe('graduated');
    expect(doc.next_steps[0].argv).toEqual(['gbrain', 'mcp', 'expose']);
    expect(doc.credentials).toContain('stay valid');
    expect(doc.mcp_client_restart).toContain('restart your MCP client');
    expect(r.api.calls.map(c => c.fn)).toEqual(['run']);
    expect(r.api.calls[0]!.opts).toMatchObject({ expectPlanHash: plan.planHash, yes: true });
    const human = await run(['--to', 'postgres', '--url-env', 'GBRAIN_TARGET_URL', '--yes', '--expect', plan.planHash]);
    expect(human.stdout).toContain('Target doctor: no failing checks');
    expect(human.stdout).toContain('gbrain mcp expose');
  });

  test('--url - reads the URL from stdin and passes it only to the orchestrator', async () => {
    const r = await run(['--to', 'postgres', '--url', '-', '--plan', '--json'], fakeApi(), { stdin: `${SECRET_URL}\n` });
    expect(r.code).toBe(0);
    expect(r.api.calls[0]!.opts!.url).toBe(SECRET_URL);
    expect(r.stdout + r.stderr).not.toContain('s3cret-pw');
  });

  test('--url-env naming an unset variable is a usage error (exit 2)', async () => {
    const r = await run(['--to', 'postgres', '--url-env', 'NOPE_URL', '--plan', '--json'], fakeApi(), { env: {} });
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout).code).toBe('invalid_params');
  });

  test('run-scoped verbs need no target flags', async () => {
    const status = await run(['--status', '--json']);
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ state: 'copying', runId: 'run-1' });
    expect((await run(['--resume', '--json'])).api.calls.map(c => c.fn)).toEqual(['resume']);
    const rb = await run(['--rollback-to-source', '--json']);
    expect(JSON.parse(rb.stdout)).toMatchObject({ status: 'abandoned' });
  });

  test('exit-code map: drain timeout 11 (blocked 1), in progress 75, SIGINT 130, refusal 1', async () => {
    const drain = await run(['--resume', '--json'], fakeApi({ resumeGraduation: async () => { throw drainTimeoutError({ timeoutSec: 60, blockers: [{ kind: 'request', id: 'r', detail: 'running', needsUser: false }] }); } }));
    expect(drain.code).toBe(11);
    expect(JSON.parse(drain.stdout).resume_command).toEqual(['gbrain', 'migrate', '--resume', '--drain-timeout', '120']);
    const blocked = await run(['--resume', '--json'], fakeApi({ resumeGraduation: async () => { throw drainTimeoutError({ timeoutSec: 60, blockers: [{ kind: 'writer_admin_lock', id: 'l', detail: 'locked', argv: ['gbrain', 'sources', 'writer', 'unlock'], needsUser: true }] }); } }));
    expect(blocked.code).toBe(1);
    const orchestratorBlocked = await run(['--resume', '--json'], fakeApi({ resumeGraduation: async () => { throw drainTimeoutError({ blockers: [{ kind: 'dangling_reference', id: 'oauth_clients.c1', detail: 'bound to a missing source', argv: ['gbrain', 'auth', 'revoke-client', 'c1'], needsUser: true }], timeoutSec: 60 }); } }));
    expect(orchestratorBlocked.code).toBe(1);
    const orchestratorProgressing = await run(['--resume', '--json'], fakeApi({ resumeGraduation: async () => { throw drainTimeoutError({ blockers: [{ kind: 'request', id: 'r', detail: 'running', needsUser: false }], timeoutSec: 60 }); } }));
    expect(orchestratorProgressing.code).toBe(11);
    const busy = await run(['--resume', '--json'], fakeApi({ resumeGraduation: async () => { throw inProgressError({ pid: 9 }); } }));
    expect(busy.code).toBe(75);
    const ctrl = new AbortController();
    const sigint = await run(['--resume', '--json'], fakeApi({ resumeGraduation: async () => { ctrl.abort(); throw new Error('stopped at batch boundary'); } }), { signal: ctrl.signal });
    expect(sigint.code).toBe(130);
    expect(JSON.parse(sigint.stdout)).toMatchObject({ code: 'interrupted', resume_command: ['gbrain', 'migrate', '--resume'] });
    const refused = await run(['--resume', '--json'], fakeApi({ resumeGraduation: async () => { throw opError('graduation_target_not_empty', 'not empty', 'pick another'); } }));
    expect(refused.code).toBe(1);
  });

  test('migrate.graduation=false refuses the plan instead of silently running the legacy copier', async () => {
    const optedOut = mkdtempSync(join(tmpdir(), 'gbrain-grad-optout-'));
    mkdirSync(join(optedOut, '.gbrain'));
    writeFileSync(join(optedOut, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', migrate: { graduation: false } }));
    try {
      const code = await withEnv({ GBRAIN_HOME: optedOut }, () => runMigrateGraduation(['--to', 'postgres', '--plan', '--json'],
        { api: fakeApi(), env: {}, out: () => {}, err: () => {}, progress: silentProgress, signal: new AbortController().signal }));
      expect(code).toBe(2);
    } finally {
      rmSync(optedOut, { recursive: true, force: true });
    }
  });
});

describe('--discard-source', () => {
  test('bare: exit 3 consent payload bound to the discard plan; nothing is deleted', async () => {
    const r = await run(['--discard-source', '--json']);
    expect(r.code).toBe(3);
    const doc = JSON.parse(r.stdout);
    expect(doc.code).toBe('confirmation_required');
    expect(doc.effects).toEqual(['destructive']);
    expect(doc.plan_hash).toBe(discardPlan.planHash);
    expect(doc.fix.argv).toEqual(['gbrain', 'migrate', '--discard-source', '--yes', '--expect', discardPlan.planHash]);
    expect(doc.fix.next).toBe('ask_user');
    expect(doc.preview.argv).toEqual(['gbrain', 'migrate', '--discard-source', '--dry-run']);
    expect(doc.user_message).toContain('brain.pglite.graduated-run-1');
    expect(doc.plan.paths.map((p: { kind: string }) => p.kind)).toEqual(['retained_copy', 'tombstone', 'intent_marker']);
    expect(r.api.calls.map(c => c.fn)).toEqual(['discard_plan']);
    const yesOnly = await run(['--discard-source', '--yes', '--json']);
    expect(yesOnly.code).toBe(3);
    expect(yesOnly.api.calls.map(c => c.fn)).toEqual(['discard_plan']);
  });

  test('--dry-run: exit 0 with the plan and the next command; the human form lists every path', async () => {
    const r = await run(['--discard-source', '--dry-run', '--json']);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc).toMatchObject({ schema_version: 1, status: 'plan', plan: { planHash: discardPlan.planHash, runId: 'run-1' } });
    expect(doc.next.command).toBe(`gbrain migrate --discard-source --yes --expect ${discardPlan.planHash}`);
    expect(r.api.calls.map(c => c.fn)).toEqual(['discard_plan']);
    const human = await run(['--discard-source', '--dry-run']);
    for (const p of discardPlan.paths) expect(human.stdout).toContain(p.path);
    expect(human.stdout).toContain('47 MB');
    expect(human.stdout).toContain(`plan_hash ${discardPlan.planHash}`);
  });

  test('--yes --expect deletes against the approved hash; --expect alone with another hash is preview_changed', async () => {
    const r = await run(['--discard-source', '--yes', '--expect', discardPlan.planHash, '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ status: 'discarded', run_id: 'run-1', source_discarded_at: '2026-10-05T00:00:00.000Z' });
    expect(r.api.calls).toEqual([{ fn: 'discard', opts: { yes: true, expectPlanHash: discardPlan.planHash } }]);
    const stale = await run(['--discard-source', '--expect', 'dh_stale', '--json']);
    expect(stale.code).toBe(1);
    expect(JSON.parse(stale.stdout).code).toBe('preview_changed');
    expect(stale.api.calls.map(c => c.fn)).toEqual(['discard_plan']);
  });

  test('nothing left: exit 0 with nothing_to_discard', async () => {
    const empty = fakeApi({ planDiscardSource: async () => ({ ...discardPlan, paths: [], sourceDiscardedAt: '2026-10-05T00:00:00.000Z' }) });
    const r = await run(['--discard-source', '--json'], empty);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ status: 'nothing_to_discard', run_id: 'run-1' });
  });

  test('refusals keep their code and exit: an unfinished run 1, a rollback in flight 75', async () => {
    const unfinished = await run(['--discard-source', '--json'], fakeApi({ planDiscardSource: async () => { throw interruptedError({ runId: 'run-1', state: 'rollback_fenced' }); } }));
    expect(unfinished.code).toBe(1);
    expect(JSON.parse(unfinished.stdout).code).toBe('graduation_interrupted');
    const inFlight = await run(['--discard-source', '--json'], fakeApi({ planDiscardSource: async () => { throw inProgressError({ runId: 'run-1', state: 'rollback_fenced' }); } }));
    expect(inFlight.code).toBe(75);
  });
});
