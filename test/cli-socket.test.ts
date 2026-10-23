/**
 * Warm CLI socket: the guards that decide whether a CLI may talk to a serve.
 *
 * 1. Protects: the identity refuses, and names, a different brain, database
 *    (a port only off a Supavisor pooler host), config home, config bytes,
 *    read-behavior env or version (never the password, a provider key's value,
 *    connection sizing or driver-only URL parameters); the run directory, the directories
 *    above it and the socket checks refuse symlinks, foreign owners, open
 *    permissions and a socket swapped after bind; the serve rejects a peer
 *    whose kernel-reported uid differs, refuses to start when peer credentials
 *    cannot be read or on a mount brain, refuses a mismatched identity, holds a
 *    request's slot until its work settles, and the CLI never connects without
 *    a peer-credential reader, bounds the whole exchange, and treats a dying
 *    serve or a malformed frame as its cold path.
 * 2. Fails when: a token input is dropped, a check follows a symlink or skips
 *    the uid comparison, the peer-credential branch is removed, or a frame
 *    field the CLI reads goes unchecked.
 * 3. The Postgres E2E (test/e2e/cli-socket-postgres.test.ts) exercises the
 *    happy path and fallbacks end to end; another uid cannot be produced there.
 * 4. Seams: startCliSocketServer's peerCred/identity/execute/home/brainId
 *    options, exchangeCliSocket's peerCred argument, FsGuardDeps.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { cliSocketIdentity, cliSocketIdentityMismatch, databaseTarget, READ_BEHAVIOR_ENV, type CliSocketIdentity } from '../src/core/cli-socket/identity.ts';
import {
  ancestorProblem, cliSocketPath, connectProblem, ensurePrivateDir, privateDirProblem, privateSocketProblem, trustedAncestorProblem, verifyBoundSocket, type FsGuardDeps,
} from '../src/core/cli-socket/fs-guard.ts';
import { peerCredSupport } from '../src/core/cli-socket/peer-cred.ts';
import { startCliSocketServer, type CliSocketBinding } from '../src/core/cli-socket/server.ts';
import { cliSocketRoundTripMs, exchangeCliSocket, renderOp } from '../src/cli/cli-socket-client.ts';
import { loadOperation } from '../src/core/operation-load.ts';
import { isResultFrame, reviveOperationError, serializeOperationError, type CliSocketRequest, type ResultFrame } from '../src/core/cli-socket/protocol.ts';
import { queueFirstFallbackHop, takeChatFallbackHopNotices, __resetChatFallbackHopNoticeForTests } from '../src/core/ai/fallback-hop-queue.ts';
import { installOutputCapture, OutputCapture, withOutputCapture } from '../src/core/cli-socket/output-capture.ts';
import { opError, OperationError } from '../src/core/ops/contract.ts';
import { loadConfigWithEngine, type GBrainConfig } from '../src/core/config.ts';

const uid = process.getuid!();
const engine = { kind: 'postgres', connectedDatabaseUrl: 'postgresql://alice-example@db.acme-example.test/brain' } as unknown as BrainEngine;
const okFrame: ResultFrame = { v: 1, kind: 'result', result: ['ok'], meta: null, notices: [], output: [], source: null };

/** A run directory under a private home, as the serve lays it out: <root>/home/.gbrain/run. */
function runDir(): string {
  const dir = join(root, 'home', '.gbrain', 'run');
  ensurePrivateDir(dir);
  return dir;
}
let root: string;

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'gbrain-cli-sock-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function homeWithConfig(name: string, body = '{"engine":"postgres"}'): { dir: string; file: string } {
  const dir = join(root, name, '.gbrain');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), body);
  return { dir, file: join(dir, 'config.json') };
}

/**
 * GBRAIN_* names in src that cannot change what a socket read answers or where
 * its text goes: writes, sync, jobs, workers, locks, doctor, setup and hooks,
 * other transports (HTTP, MCP surface, thin client), the database URL variables
 * (compared as a database target), connection sizing and driver tuning,
 * location variables compared by what they resolve to (GBRAIN_HOME as the config
 * home, GBRAIN_BRAIN_ID as the brain id, GBRAIN_MOUNTS_PATH for mount brains the
 * socket never serves, GBRAIN_CWD_ENV_QUARANTINED whose effect is already in the
 * env it left), diagnostics, settings only the CLI's own renderer reads (GBRAIN_FAIL_ON_EMPTY:
 * the warm path renders and sets the exit code in the CLI, with the CLI's
 * environment), and constants that only share the prefix. Families are listed
 * by prefix only where no member reads; anything else is named.
 */
const NOT_READ_BEHAVIOR_PREFIXES = [
  'GBRAIN_ALLOW', 'GBRAIN_AUTOPILOT_', 'GBRAIN_BACKUP_', 'GBRAIN_BULK', 'GBRAIN_CLAUDE_CLI_', 'GBRAIN_CLAW_', 'GBRAIN_CONNECTOR',
  'GBRAIN_CYCLE_', 'GBRAIN_DOCTOR_', 'GBRAIN_DREAM', 'GBRAIN_DRIFT_', 'GBRAIN_EMBED_', 'GBRAIN_EXTRACT', 'GBRAIN_FENCE_', 'GBRAIN_FORCE_',
  'GBRAIN_GIT', 'GBRAIN_GRADUATION_', 'GBRAIN_HOOK', 'GBRAIN_HTTP_', 'GBRAIN_JOB_', 'GBRAIN_LINK_RESOLUTION_', 'GBRAIN_LOCK_', 'GBRAIN_MIGRATE_',
  'GBRAIN_MINION', 'GBRAIN_NO_', 'GBRAIN_NOTIFIER', 'GBRAIN_NTB_', 'GBRAIN_OAUTH_', 'GBRAIN_PACE', 'GBRAIN_PG_', 'GBRAIN_PGLITE_', 'GBRAIN_POOL_',
  'GBRAIN_PROGRESSIVE_BATCH_', 'GBRAIN_QUEUE_', 'GBRAIN_SETUP_', 'GBRAIN_STOP_PUSH', 'GBRAIN_SUPERVIS', 'GBRAIN_SWEEP', 'GBRAIN_SYNC', 'GBRAIN_WORKER_',
];
const NOT_READ_BEHAVIOR = new Set([
  'GBRAIN_HOME', 'GBRAIN_SERVE_LOG_MAX_BYTES', 'GBRAIN_SERVE_LOG_MAX_FILES', 'GBRAIN_SERVE_LOG_DEDUPE_SECONDS', 'GBRAIN_BRAIN_ID', 'GBRAIN_MOUNTS_PATH', 'GBRAIN_CWD_ENV_QUARANTINED',
  'GBRAIN_FAIL_ON_EMPTY', 'GBRAIN_CLI_SOCKET', 'GBRAIN_DEBUG', 'GBRAIN_SQL_TRACE', 'GBRAIN_SQL_TRACE_LABEL', 'GBRAIN_LME_DEBUG', 'GBRAIN_SOURCE',
  'GBRAIN_DATABASE_URL', 'GBRAIN_DIRECT_DATABASE_URL', 'GBRAIN_DIRECT_POOL_SIZE', 'GBRAIN_DIRECT_POOL_BY_COMMAND', 'GBRAIN_DISABLE_DIRECT_POOL', 'GBRAIN_PREPARE',
  'GBRAIN_IDLE_TX_TIMEOUT', 'GBRAIN_MAX_CONNECTIONS', 'GBRAIN_NO_RETRY_CONNECT', 'GBRAIN_DB_ACCESS',
  'GBRAIN_ACCEPT_PENDING', 'GBRAIN_ACCEPT_SILENT_WIDEN', 'GBRAIN_WRITE_WAIT_MS', 'GBRAIN_ONESHOT_HOUSEKEEPING_INTERVAL_MS', 'GBRAIN_PREADMIT_CACHE', 'GBRAIN_PREPARATION_DEADLINES',
  'GBRAIN_SINGLE_CONSUMER', 'GBRAIN_SINGLE_WRITE_GROUP', 'GBRAIN_CONSUMER_DIRECT_LANE', 'GBRAIN_COMMIT_LOCK_WAIT_SECONDS', 'GBRAIN_COMMIT_VIA', 'GBRAIN_COMMIT_GUARD',
  'GBRAIN_PUBLISH_LOCK_WAIT_SECONDS', 'GBRAIN_PUSH_LOCK_WAIT_SECONDS', 'GBRAIN_PAGE_BLOCK_BYTES', 'GBRAIN_PAGE_WARN_BYTES', 'GBRAIN_INGEST_MAX_BYTES',
  'GBRAIN_BELIEF_PREIMAGE_CHECK', 'GBRAIN_BLOCK_MARKERS', 'GBRAIN_CANCEL_SETTLE_MS', 'GBRAIN_CHUNKER_TIMEOUT_MS', 'GBRAIN_CONTENT_REPAIR_CALL_TIMEOUT_MS',
  'GBRAIN_CONTEXTUAL_CHUNK_CONCURRENCY', 'GBRAIN_CONTEXTUAL_HAIKU_RPM', 'GBRAIN_CONTEXTUAL_SYNOPSIS_RPM', 'GBRAIN_CONTRADICTIONS_JUDGE_MODEL',
  'GBRAIN_CORPUS_WINDOWS_PER_SWEEP', 'GBRAIN_DEFERRED_EMBED_RETRY_MS', 'GBRAIN_DRAIN_TIMEOUT_MS', 'GBRAIN_FLUSH_GRACE_MS', 'GBRAIN_GITHUB_PAT',
  'GBRAIN_GITHUB_REPO', 'GBRAIN_GLOBAL_MAINTENANCE_TIMEOUT_MS', 'GBRAIN_LLM_HALT_COOLDOWN', 'GBRAIN_MAX_FENCES_PER_PAGE', 'GBRAIN_MAX_SKILL_MD_BYTES',
  'GBRAIN_MAX_WALK_DEPTH', 'GBRAIN_ORPHANED_PRIVATE_QUEUE_MINUTES', 'GBRAIN_PHANTOM_REDIRECT_LIMIT', 'GBRAIN_PLANNER_AUTO_ANALYZE',
  'GBRAIN_REFRESH_DRAIN_WAIT_MS', 'GBRAIN_REFRESH_FETCH_TIMEOUT_MS', 'GBRAIN_SKIP_REFERENCE_SWEEP', 'GBRAIN_SKIP_STARTUP_HOOKS', 'GBRAIN_TRAJECTORY_REGRESSION_THRESHOLD',
  'GBRAIN_WEDGED_QUEUE_WARN_MINUTES', 'GBRAIN_ANTHROPIC_MAX_INFLIGHT',
  'GBRAIN_SERVE_BOOT_TIMEOUT_SECONDS', 'GBRAIN_SERVE_EOF_DRAIN_MS', 'GBRAIN_SERVE_FAIL_FAST', 'GBRAIN_SERVE_HEAD_DEBOUNCE_MS', 'GBRAIN_SERVE_HEAD_POLL_MS',
  'GBRAIN_SERVE_RESTART_REQUIRED_EXIT_SECONDS', 'GBRAIN_SERVE_STALL_WATCHDOG_MS', 'GBRAIN_SERVE_SYNC_IPC', 'GBRAIN_SERVE_SYNC_SETTLE_MS',
  'GBRAIN_SURFACE', 'GBRAIN_MCP_FORCE_SURFACE', 'GBRAIN_MCP_INSTRUCTIONS', 'GBRAIN_SOCKET_KINDS', 'GBRAIN_HEALTH_CACHE_TTL_MS', 'GBRAIN_CLIENT_CHECK_INTERVAL',
  'GBRAIN_CLIENT_HEADER', 'GBRAIN_STDIN_TIMEOUT_MS', 'GBRAIN_STDOUT_DRAIN_DEADLINE_MS', 'GBRAIN_TEARDOWN_DEADLINE_MS', 'GBRAIN_PID1_REAP', 'GBRAIN_NICE',
  'GBRAIN_REMOTE_CLIENT_ID', 'GBRAIN_REMOTE_CLIENT_SECRET', 'GBRAIN_REMOTE_ISSUER_URL', 'GBRAIN_REMOTE_MCP_URL', 'GBRAIN_REMOTE_TOKEN', 'GBRAIN_REMOTE_TOKEN_ENV',
  'GBRAIN_THIN_CLIENT_NAME', 'GBRAIN_TAILSCALE_LOGIN_TIMEOUT_MS', 'GBRAIN_ADMIN_BOOTSTRAP_TOKEN',
  'GBRAIN_SCHEMA_AUDIT_VERBOSE', 'GBRAIN_SCHEMA_LOCK_TIMEOUT_SECONDS', 'GBRAIN_SCHEMA_PACK_MAX_BYTES', 'GBRAIN_SCHEMA_PACK_WARN_BYTES',
  'GBRAIN_INITSCHEMA_LOCK_TIMEOUT_SECONDS', 'GBRAIN_INIT_SKIP_EMBED_CHECK', 'GBRAIN_IN_AGENT_SETUP', 'GBRAIN_INTERACTIVE', 'GBRAIN_NON_INTERACTIVE',
  'GBRAIN_BOOTSTRAP_ABORT_AFTER', 'GBRAIN_SEAT', 'GBRAIN_CORE', 'GBRAIN_PRESSURE', 'GBRAIN_PAYLOAD', 'GBRAIN_DESCRIPTION', 'GBRAIN_HARNESS_MARKER_VALUE',
  'GBRAIN_ENV_TEMPLATE', 'GBRAIN_SKILLS_DIR', 'GBRAIN_COORDINATION_HOME', 'GBRAIN_AUDIT_DIR', 'GBRAIN_TARGET_URL', 'GBRAIN_UPGRADE_OWNS_MIGRATIONS',
  'GBRAIN_SELF_UPGRADE_MODE', 'GBRAIN_SWAP_RECEIPT', 'GBRAIN_POST_UPGRADE_TIMEOUT_MS', 'GBRAIN_PROBE_PROMPT_GRACE_SECONDS', 'GBRAIN_BANNER',
  'GBRAIN_BIN', 'GBRAIN_BIN_OVERRIDE', 'GBRAIN_BINARY_VERSION', 'GBRAIN_ROOT', 'GBRAIN_VERIFY', 'GBRAIN_FRICTION_RUN_ID', 'GBRAIN_NOTABILITY_EVAL_REAL',
  'GBRAIN_WHOKNOWS_FIXTURE_PATH', 'GBRAIN_PACK_STAT_TTL_MS', 'GBRAIN_EMBEDDING', 'GBRAIN_BASE_PATH_PREFIXES', 'GBRAIN_RECOVERED_RETRY',
]);

describe('identity', () => {
  const url = 'postgresql://alice-example:secret-one@db.acme-example.test:6543/brain?sslmode=require&application_name=x';
  const pooler = 'postgresql://postgres.project-a:secret-one@aws-0-region-a.pooler.supabase.com';
  const identity = (overrides: Partial<Parameters<typeof cliSocketIdentity>[0]> = {}) => {
    const dir = join(root, 'a', '.gbrain');
    return cliSocketIdentity({ config: { engine: 'postgres', database_url: url }, brainId: 'host', configDir: dir, configFile: join(dir, 'config.json'), version: '1.0.0', env: {}, ...overrides });
  };
  const at = (databaseUrl: string, env: Record<string, string> = {}) => identity({ config: { engine: 'postgres', database_url: databaseUrl }, env });

  test('the database target drops the password and driver-only parameters, keeps options', () => {
    expect(databaseTarget(url)).toEqual(databaseTarget('postgres://alice-example:other@DB.acme-example.test:6543/brain?prepare=false&connect_timeout=5'));
    expect(JSON.stringify(databaseTarget(url))).not.toContain('secret-one');
    expect(databaseTarget(`${url}&options=-c%20search_path%3Dother`)).not.toEqual(databaseTarget(url));
  });

  test('a session-lane serve answers a transaction-lane CLI on the same Supavisor host, user and database (prepare=, pool sizing and the URL variables differ)', () => {
    homeWithConfig('a');
    const serve = at(`${pooler}:5432/postgres`, { GBRAIN_POOL_SIZE: '10', GBRAIN_DATABASE_URL: `${pooler}:5432/postgres`, GBRAIN_HOME: '/home/alice-example' });
    const cli = at(`${pooler}:6543/postgres?prepare=false`, { GBRAIN_POOL_SIZE: '2', GBRAIN_DIRECT_POOL_SIZE: '1', GBRAIN_PREPARE: 'false',
      GBRAIN_DATABASE_URL: `${pooler}:6543/postgres?prepare=false`, GBRAIN_HOME: '/home/alice-example' });
    expect(cliSocketIdentityMismatch(serve, cli)).toBeNull();
  });

  test('on the pooler a different user or database is refused, and named', () => {
    homeWithConfig('a');
    const serve = at(`${pooler}:5432/postgres`);
    expect(cliSocketIdentityMismatch(serve, at(`${pooler.replace('project-a', 'project-b')}:6543/postgres`))).toBe('database user');
    expect(cliSocketIdentityMismatch(serve, at(`${pooler}:6543/other`))).toBe('database database');
    expect(cliSocketIdentityMismatch(serve, at(`${pooler.replace('region-a', 'region-b')}:6543/postgres`))).toBe('database host');
  });

  test('on plain Postgres another port is another server: refused, and named', () => {
    homeWithConfig('a');
    expect(cliSocketIdentityMismatch(at(url), at(url.replace(':6543', ':5432')))).toBe('database port');
    expect(cliSocketIdentityMismatch(at(url), at(url.replace(':6543', ':6543')))).toBeNull();
    expect(cliSocketIdentityMismatch(at(url), at(url.replace('db.acme', 'db2.acme')))).toBe('database host');
    expect(cliSocketIdentityMismatch(at(url), identity({ config: { engine: 'postgres', database_url: undefined } }))).toBe('database');
  });

  test('names the config home, config bytes, version and brain id (a mount serve never matches a host CLI); a rotated password still matches', () => {
    const home = homeWithConfig('a');
    const base = identity();
    expect(cliSocketIdentityMismatch(base, identity())).toBeNull();
    expect(cliSocketIdentityMismatch(base, at(url.replace('secret-one', 'rotated')))).toBeNull();
    expect(cliSocketIdentityMismatch(base, identity({ version: '1.0.1' }))).toBe('version');
    expect(cliSocketIdentityMismatch(base, identity({ brainId: 'mnt-example' }))).toBe('brain');
    const other = homeWithConfig('b');
    expect(cliSocketIdentityMismatch(base, identity({ configDir: other.dir, configFile: other.file }))).toBe('config home');
    writeFileSync(home.file, '{"engine":"postgres","edited":true}');
    expect(cliSocketIdentityMismatch(base, identity())).toBe('config contents');
  });

  test('a sizing or driver variable may differ, and so may a location variable that resolves to the same home and brain (one side exporting GBRAIN_HOME, the other relying on HOME); a read-behavior variable may not, and is named without its value', () => {
    homeWithConfig('a');
    const base = identity({ env: { HOME: '/home/alice-example', GBRAIN_HOME: '/home/alice-example' } });
    for (const env of [{ GBRAIN_POOL_SIZE: '10' }, { GBRAIN_DIRECT_POOL_SIZE: '4' }, { GBRAIN_PREPARE: 'true' }, { GBRAIN_POOL_MAX_LIFETIME_S: '60' },
      { GBRAIN_CLI_SOCKET: '1', GBRAIN_DEBUG: '1', GBRAIN_SQL_TRACE: '/tmp/t.jsonl' }, { GBRAIN_SOURCE: 'source-a' }, { HOME: '/elsewhere' }]) {
      expect(cliSocketIdentityMismatch(base, identity({ env: { HOME: '/home/alice-example', GBRAIN_HOME: '/home/alice-example', ...env } })), JSON.stringify(env)).toBeNull();
    }
    const contributor = identity({ env: { GBRAIN_HOME: '/home/alice-example', GBRAIN_CONTRIBUTOR_MODE: '1' } });
    expect(cliSocketIdentityMismatch(base, contributor)).toBe('env GBRAIN_CONTRIBUTOR_MODE');
    expect(cliSocketIdentityMismatch(base, identity({ env: { HOME: '/home/alice-example' } }))).toBeNull();
    expect(cliSocketIdentityMismatch(base, identity({ env: { GBRAIN_HOME: '/home/alice-example', GBRAIN_BRAIN_ID: 'host', GBRAIN_MOUNTS_PATH: '/home/alice-example/.gbrain/mounts.json' } }))).toBeNull();
    expect(cliSocketIdentityMismatch(base, identity({ env: { GBRAIN_HOME: '/home/alice-example', GBRAIN_MODEL: 'model-a' } }))).toBe('env GBRAIN_MODEL');
    expect(JSON.stringify(identity({ env: { GBRAIN_MODEL: 'model-secretish' } }))).not.toContain('model-secretish');
  });

  test('provider routing values enter with their value (a local and a remote endpoint never match); credentials only as set or not', () => {
    homeWithConfig('a');
    const env = (extra: Record<string, string>) => identity({ env: { GBRAIN_HOME: '/home/alice-example', ...extra } });
    expect(cliSocketIdentityMismatch(env({ OPENAI_BASE_URL: 'http://127.0.0.1:11434/v1' }), env({ OPENAI_BASE_URL: 'https://api.openai.com/v1' }))).toBe('env OPENAI_BASE_URL');
    for (const name of ['OLLAMA_BASE_URL', 'LMSTUDIO_BASE_URL', 'LLAMA_SERVER_BASE_URL', 'LLAMA_SERVER_RERANKER_BASE_URL', 'LITELLM_BASE_URL', 'OPENROUTER_BASE_URL',
      'ANTHROPIC_BASE_URL', 'AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_DEPLOYMENT', 'AZURE_OPENAI_API_VERSION', 'OPENAI_ORG_ID', 'OPENAI_PROJECT', 'MINIMAX_GROUP_ID']) {
      expect(cliSocketIdentityMismatch(env({ [name]: 'value-one' }), env({ [name]: 'value-two' })), name).toBe(`env ${name}`);
    }
    for (const name of ['OPENAI_API_KEY', 'AZURE_OPENAI_API_KEY', 'LLAMA_SERVER_API_KEY', 'VOYAGE_API_KEY']) {
      expect(cliSocketIdentityMismatch(env({ [name]: 'value-one' }), env({ [name]: 'value-two' })), name).toBeNull();
      expect(cliSocketIdentityMismatch(env({}), env({ [name]: 'value-one' })), name).toBe(`provider key ${name}`);
    }
    expect(cliSocketIdentityMismatch(env({}), env({ VOYAGE_API_KEY: '' }))).toBeNull();
    expect(JSON.stringify(env({ VOYAGE_API_KEY: 'value-one' }))).not.toContain('value-one');
  });

  test('every GBRAIN_* name in src is classified: read behavior (READ_BEHAVIOR_ENV) or listed here as unable to change a socket read', () => {
    const names = new Set<string>();
    for (const file of new Bun.Glob('src/**/*.ts').scanSync('.')) {
      for (const match of readFileSync(file, 'utf8').matchAll(/GBRAIN_[A-Z0-9_]*[A-Z0-9]/g)) names.add(match[0]);
    }
    const unclassified = [...names].filter(name => !READ_BEHAVIOR_ENV.includes(name)
      && !NOT_READ_BEHAVIOR.has(name) && !NOT_READ_BEHAVIOR_PREFIXES.some(prefix => name.startsWith(prefix))).sort();
    expect(unclassified).toEqual([]);
    for (const name of READ_BEHAVIOR_ENV) expect(names.has(name), name).toBe(true);
  });
});

describe('run directory and socket checks', () => {
  test('ensurePrivateDir creates 0700, tightens an open directory this uid owns, refuses a symlink', () => {
    const dir = join(root, 'home', '.gbrain', 'run');
    ensurePrivateDir(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    chmodSync(dir, 0o755);
    expect(privateDirProblem(dir)).toBe('open_permissions');
    ensurePrivateDir(dir);
    expect(privateDirProblem(dir)).toBeNull();
    const link = join(root, 'link-run');
    symlinkSync(dir, link);
    expect(privateDirProblem(link)).toBe('symlink');
    expect(() => ensurePrivateDir(link)).toThrow(/symlink/);
  });

  test('a directory or socket owned by another uid is refused, never repaired', () => {
    const dir = runDir();
    const foreign: FsGuardDeps = { lstat: path => lstatSync(path), stat: path => statSync(path), uid: () => uid + 1 };
    expect(privateDirProblem(dir, foreign)).toBe('foreign_owner');
    expect(() => ensurePrivateDir(dir, foreign)).toThrow(/foreign_owner/);
    expect(privateDirProblem(dir, { ...foreign, uid: () => undefined })).toBe('no_uid');
  });

  test('the CLI refuses a regular file, a symlinked socket and an open socket before connecting', async () => {
    const dir = runDir();
    const path = join(dir, 'cli.sock');
    expect(connectProblem(path, dir)).toBe('missing');
    writeFileSync(path, 'x');
    expect(privateSocketProblem(path)).toBe('not_socket');
    rmSync(path);
    const real = join(root, 'real.sock');
    const server = net.createServer();
    await new Promise<void>(resolve => server.listen(real, resolve));
    try {
      symlinkSync(real, path);
      expect(connectProblem(path, dir)).toBe('symlink');
      rmSync(path);
      chmodSync(real, 0o666);
      expect(privateSocketProblem(real)).toBe('open_permissions');
      chmodSync(real, 0o600);
      expect(privateSocketProblem(real)).toBeNull();
      expect(privateSocketProblem(real, { lstat: p => lstatSync(p), uid: () => uid + 1 })).toBe('foreign_owner');
    } finally {
      server.close();
    }
  });

  test('GBRAIN_HOME and .gbrain must be this user\'s and writable by no one else (sticky excepted), on both sides', () => {
    const dir = runDir();
    const home = join(root, 'home');
    const path = join(dir, 'cli.sock');
    expect(ancestorProblem(dir)).toBeNull();
    for (const [target, mode] of [[home, 0o775], [home, 0o757], [join(home, '.gbrain'), 0o770]] as const) {
      chmodSync(target, mode);
      expect(ancestorProblem(dir)).toEqual({ path: target, reason: 'open_permissions' });
      expect(connectProblem(path, dir)).toBe('open_permissions');
      expect(() => ensurePrivateDir(dir)).toThrow(/open_permissions/);
      chmodSync(target, 0o700);
    }
    chmodSync(home, 0o1777);
    expect(trustedAncestorProblem(home)).toBeNull();
    chmodSync(home, 0o700);
    const foreignHome: FsGuardDeps = { lstat: p => lstatSync(p), stat: p => p === home ? { ...statSync(p), isDirectory: () => true, uid: uid + 1 } as never : statSync(p), uid: () => uid };
    expect(ancestorProblem(dir, foreignHome)).toEqual({ path: home, reason: 'foreign_owner' });
    expect(() => ensurePrivateDir(dir, foreignHome)).toThrow(/foreign_owner/);
  });

  test('a bound socket is only verified, never chmod\'ed: an open, symlinked or foreign one is refused as found', async () => {
    const dir = runDir();
    const path = join(dir, 'cli.sock');
    const server = net.createServer();
    const umask = process.umask(0o022);
    try { await new Promise<void>(resolve => server.listen(path, resolve)); } finally { process.umask(umask); }
    try {
      const real: FsGuardDeps = { lstat: p => lstatSync(p), uid: () => uid };
      const openMode = lstatSync(path).mode & 0o777;
      expect(openMode & 0o077).not.toBe(0);
      expect(() => verifyBoundSocket(path, real)).toThrow(/open_permissions/);
      expect(lstatSync(path).mode & 0o777).toBe(openMode);
      chmodSync(path, 0o600);
      expect(verifyBoundSocket(path, real)).toBe(lstatSync(path).ino);
      expect(() => verifyBoundSocket(path, { ...real, lstat: p => ({ ...lstatSync(p), isSymbolicLink: () => true, isSocket: () => false }) as never })).toThrow(/symlink/);
      expect(() => verifyBoundSocket(path, { ...real, uid: () => uid + 1 })).toThrow(/foreign_owner/);
    } finally {
      server.close();
    }
  });
});

describe('serve listener', () => {
  const bindings: CliSocketBinding[] = [];
  afterEach(() => { for (const b of bindings.splice(0)) b.close(); });

  const serveIdentity = (databaseUrl = 'postgresql://alice-example@db.acme-example.test/brain'): CliSocketIdentity => (mkdirSync(join(root, 'home', '.gbrain'), { recursive: true, mode: 0o700 }), cliSocketIdentity({
    config: { engine: 'postgres', database_url: databaseUrl }, brainId: 'host', configDir: join(root, 'home', '.gbrain'), configFile: join(root, 'home', '.gbrain', 'config.json'), version: '1.0.0', env: {} }));
  const request = (identity: CliSocketIdentity): CliSocketRequest => ({ v: 1, identity, command: 'search', kind: 'op', op: 'search', params: { query: 'q' },
    routing: { cwd: '/', source_env: null }, cli: { quiet: false, timeout_ms: null } });

  async function start(overrides: Partial<Parameters<typeof startCliSocketServer>[0]> = {}) {
    const lines: string[] = [];
    const home = join(root, 'home', '.gbrain');
    const binding = await startCliSocketServer({ engine, log: line => lines.push(line), home, identity: serveIdentity(), brainId: () => 'host',
      execute: async () => ({ frame: okFrame, settled: Promise.resolve() }), ...overrides });
    if (binding) bindings.push(binding);
    return { binding, lines, path: cliSocketPath(home) };
  }

  test('this platform reads peer credentials (otherwise the serve would refuse to start)', () => {
    if (process.platform === 'linux' || process.platform === 'darwin') expect(peerCredSupport().ok).toBe(true);
  });

  test('binds 0600 even under an open process umask (the kernel creates it so), restores the umask, and answers a matching identity; refuses a mismatched one', async () => {
    const umask = process.umask(0o000);
    let started: Awaited<ReturnType<typeof start>>;
    try { started = await start(); expect(process.umask()).toBe(0o000); } finally { process.umask(umask); }
    const { binding, path } = started;
    expect(binding).not.toBeNull();
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(await exchangeCliSocket(path, request(serveIdentity()), 5_000)).toEqual({ frame: okFrame });
    expect(await exchangeCliSocket(path, request({ ...serveIdentity(), version: '1.0.1' }), 5_000)).toEqual({ reason: 'refused (identity_mismatch): version' });
    expect(await exchangeCliSocket(path, request(serveIdentity('postgresql://alice-example@db.acme-example.test:6543/brain')), 5_000)).toEqual({ reason: 'refused (identity_mismatch): database port' });
    expect(started.lines.filter(line => line.includes('identity_mismatch'))).toEqual([
      "[gbrain serve] cli-socket: refused a CLI call: identity_mismatch (version differs from this serve's); that CLI takes its cold path.",
      "[gbrain serve] cli-socket: refused a CLI call: identity_mismatch (database port differs from this serve's); that CLI takes its cold path.",
    ]);
    await exchangeCliSocket(path, request({ ...serveIdentity(), version: '1.0.1' }), 5_000);
    expect(started.lines.filter(line => line.includes('identity_mismatch')).length).toBe(2);
  });

  test('rejects a peer whose kernel uid differs, and one whose uid cannot be read', async () => {
    let calls = 0;
    // The first read is the start-up self-test on this process's own connection.
    const { binding, path, lines } = await start({ peerCred: { ok: true, read: () => (calls++ === 0 ? uid : uid + 1) } });
    expect(binding).not.toBeNull();
    const outcome = await exchangeCliSocket(path, request(serveIdentity()), 5_000);
    expect('reason' in outcome && outcome.reason).toMatch(/^serve_closed|connect_failed|lost/);
    expect(lines.join('\n')).toContain(`rejected a connection from uid ${uid + 1}`);
    binding!.close();
    bindings.length = 0;
    calls = 0;
    const second = await start({ peerCred: { ok: true, read: () => (calls++ === 0 ? uid : null) } });
    expect(await exchangeCliSocket(second.path, request(serveIdentity()), 5_000)).toHaveProperty('reason');
    expect(second.lines.join('\n')).toContain('rejected a connection from an unverifiable peer');
  });

  test('fails closed when peer credentials are unsupported or the self-test sees another uid', async () => {
    const unsupported = await start({ peerCred: { ok: false, reason: 'no peer-credential call is wired for testos' } });
    expect(unsupported.binding).toBeNull();
    expect(unsupported.lines.join('\n')).toContain('peer credentials cannot be verified on this platform (no peer-credential call is wired for testos)');
    expect(() => lstatSync(unsupported.path)).toThrow();
    const wrong = await start({ peerCred: { ok: true, read: () => uid + 1 } });
    expect(wrong.binding).toBeNull();
    expect(wrong.lines.join('\n')).toContain('self-test');
  });

  test('refuses PGLite brains and a symlinked run directory', async () => {
    expect((await start({ engine: { kind: 'pglite' } as BrainEngine })).binding).toBeNull();
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(elsewhere, { mode: 0o700 });
    mkdirSync(join(root, 'home', '.gbrain'), { recursive: true });
    symlinkSync(elsewhere, join(root, 'home', '.gbrain', 'run'));
    const { binding, lines } = await start();
    expect(binding).toBeNull();
    expect(lines.join('\n')).toContain('(symlink)');
  });

  test('refuses to start on a mount brain, or when the engine does not report the database it connected to', async () => {
    const mount = await start({ brainId: () => 'mnt-example' });
    expect(mount.binding).toBeNull();
    expect(mount.lines.join('\n')).toContain('this serve is on mount brain "mnt-example"');
    expect(() => lstatSync(mount.path)).toThrow();
    const unknown = await start({ engine: { kind: 'postgres' } as BrainEngine });
    expect(unknown.binding).toBeNull();
    expect(unknown.lines.join('\n')).toContain('does not report the database it connected to');
  });

  test('a request holds its slot until its work settles, not until it answered', async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const { path } = await start({ execute: async () => ({ frame: { v: 1, kind: 'fallback', reason: 'timeout' }, settled: pending }) });
    for (let i = 0; i < 8; i++) expect(await exchangeCliSocket(path, request(serveIdentity()), 5_000)).toEqual({ frame: { v: 1, kind: 'fallback', reason: 'timeout' } });
    expect(await exchangeCliSocket(path, request(serveIdentity()), 5_000)).toEqual({ reason: 'refused (busy)' });
    release();
    await Bun.sleep(20);
    expect(await exchangeCliSocket(path, request(serveIdentity()), 5_000)).toHaveProperty('frame');
  });

  test('a request whose work is still unsettled at the round-trip cap is logged once', async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const { path, lines } = await start({ stuckAfterMs: 50, execute: async () => ({ frame: { v: 1, kind: 'fallback', reason: 'timeout' }, settled: pending }) });
    await exchangeCliSocket(path, request(serveIdentity()), 5_000);
    await Bun.sleep(150);
    expect(lines.filter(line => line.includes('is still running')).length).toBe(1);
    expect(lines.join('\n')).toContain('a search request is still running');
    release();
    await Bun.sleep(20);
    const { path: second, lines: quiet } = await start({ home: join(root, 'quiet', '.gbrain'), stuckAfterMs: 50 } as never);
    await exchangeCliSocket(second, request(serveIdentity()), 5_000);
    await Bun.sleep(150);
    expect(quiet.filter(line => line.includes('is still running'))).toEqual([]);
  });

  test('without a peer-credential reader the CLI never connects', async () => {
    const { path } = await start();
    let connections = 0;
    const counter = net.createServer(socket => { connections++; socket.destroy(); });
    const probe = join(runDir(), 'probe.sock');
    await new Promise<void>(resolve => counter.listen(probe, resolve));
    try {
      expect(await exchangeCliSocket(probe, request(serveIdentity()), 5_000, { ok: false, reason: 'no peer-credential call is wired for testos' }))
        .toEqual({ reason: 'peer_credentials_unsupported (no peer-credential call is wired for testos)' });
      await Bun.sleep(20);
      expect(connections).toBe(0);
      expect(await exchangeCliSocket(path, request(serveIdentity()), 5_000)).toEqual({ frame: okFrame });
    } finally {
      counter.close();
    }
  });

  test('a response frame missing a field the CLI reads, or of an unknown kind, is malformed', async () => {
    const valid: unknown[] = [okFrame, { v: 1, kind: 'error', error: { code: 'page_not_found', message: 'm' }, output: [['stderr', 'x']] }, { v: 1, kind: 'fallback', reason: 'r' }];
    for (const frame of valid) expect(isResultFrame(frame)).toBe(true);
    const malformed: unknown[] = [
      { v: 1, kind: 'result', result: 1, meta: null, notices: [] },
      { v: 1, kind: 'result', result: 1, meta: null, notices: [], output: [['stdout']] },
      { v: 1, kind: 'result', result: 1, meta: 'x', notices: [], output: [] },
      { v: 1, kind: 'result', result: 1, meta: null, notices: [{}], output: [] },
      { v: 1, kind: 'result', result: 1, meta: null, notices: [{ code: 'x' }], output: [] },
      { v: 1, kind: 'error', output: [] },
      { v: 1, kind: 'error', error: { message: 'no code' }, output: [] },
      { v: 1, kind: 'timeout', label: 'l', ms: 1, output: [] },
      { v: 1, kind: 'mystery' },
      { v: 1, kind: 'fallback' },
      { v: 2, kind: 'fallback', reason: 'r' },
    ];
    for (const frame of malformed) expect(isResultFrame(frame)).toBe(false);
    const dir = runDir();
    const path = join(dir, 'cli.sock');
    const lines = [JSON.stringify(malformed[0]), JSON.stringify({ v: 1, accepted: 'yes' })];
    for (const [handshake, result] of [['{"v":1,"accepted":true}', lines[0]], [lines[1], '']] as const) {
      const server = net.createServer(socket => socket.once('data', () => socket.write(`${handshake}\n${result}${result ? '\n' : ''}`)));
      await new Promise<void>(resolve => server.listen(path, resolve));
      try {
        expect(await exchangeCliSocket(path, request(serveIdentity()), 5_000)).toEqual({ reason: 'malformed_response' });
      } finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    }
  });

  test('the whole exchange is bounded: about 30 s, or the CLI\'s --timeout when shorter', async () => {
    expect(cliSocketRoundTripMs(null)).toBe(30_000);
    expect(cliSocketRoundTripMs(5_000)).toBe(5_000);
    expect(cliSocketRoundTripMs(600_000)).toBe(30_000);
    const path = join(runDir(), 'cli.sock');
    const server = net.createServer(socket => socket.once('data', () => socket.write('{"v":1,"accepted":true}\n')));
    await new Promise<void>(resolve => server.listen(path, resolve));
    try {
      const started = performance.now();
      expect(await exchangeCliSocket(path, request(serveIdentity()), 300)).toEqual({ reason: 'round_trip_timeout' });
      expect(performance.now() - started).toBeLessThan(2_000);
    } finally {
      server.close();
    }
  });

  test('a serve that dies after the handshake sends the CLI to its cold path', async () => {
    const path = join(runDir(), 'cli.sock');
    const server = net.createServer(socket => socket.once('data', () => { socket.write('{"v":1,"accepted":true}\n'); setTimeout(() => socket.destroy(), 20); }));
    await new Promise<void>(resolve => server.listen(path, resolve));
    try {
      expect(await exchangeCliSocket(path, request(serveIdentity()), 5_000)).toEqual({ reason: 'serve_closed_mid_request' });
    } finally {
      server.close();
    }
  });

  test('a wedged serve that never answers the handshake is abandoned within the handshake timeout', async () => {
    const path = join(runDir(), 'cli.sock');
    const server = net.createServer(() => { /* never answers */ });
    await new Promise<void>(resolve => server.listen(path, resolve));
    try {
      const started = performance.now();
      expect(await exchangeCliSocket(path, request(serveIdentity()), 60_000)).toEqual({ reason: 'handshake_timeout' });
      expect(performance.now() - started).toBeLessThan(3_000);
    } finally {
      server.close();
    }
  });
});

test('a well-formed frame whose payload the renderer cannot handle prints nothing and sends the CLI to its cold path', async () => {
  const op = (await loadOperation('search'))!;
  const written: string[] = [];
  const saved = { out: process.stdout.write, err: process.stderr.write };
  const record = (chunk: unknown) => { written.push(String(chunk)); return true; };
  process.stdout.write = record as typeof process.stdout.write;
  process.stderr.write = record as typeof process.stderr.write;
  let outcome: boolean | Error;
  try {
    outcome = await renderOp('search', op, { query: 'q' }, { v: 1, kind: 'result', result: 5, meta: null, notices: [], output: [['stdout', 'handler line\n']], source: null })
      .catch((error: Error) => error);
  } finally {
    Object.assign(process.stdout, { write: saved.out });
    Object.assign(process.stderr, { write: saved.err });
  }
  expect(outcome).toBe(false);
  expect(written).toEqual([]);
});

test('each warm request has its own first chat-fallback hop queue; the process queue is untouched', async () => {
  installOutputCapture();
  __resetChatFallbackHopNoticeForTests();
  const hop = (why: string) => () => ({ code: 'chat_fallback_hop', kind: 'safety', why }) as never;
  expect(queueFirstFallbackHop(hop('process'))).toBe(true);
  const seen: unknown[][] = [];
  for (const name of ['a', 'b']) {
    await withOutputCapture(new OutputCapture(), async () => {
      expect(queueFirstFallbackHop(hop(name))).toBe(true);
      expect(queueFirstFallbackHop(hop(`${name}-again`))).toBe(false);
      seen.push(takeChatFallbackHopNotices());
    });
  }
  expect(seen).toEqual([[{ code: 'chat_fallback_hop', kind: 'safety', why: 'a' }], [{ code: 'chat_fallback_hop', kind: 'safety', why: 'b' }]]);
  expect(takeChatFallbackHopNotices()).toEqual([{ code: 'chat_fallback_hop', kind: 'safety', why: 'process' }]);
  __resetChatFallbackHopNoticeForTests();
});

test('an OperationError round-trips with every field the CLI renderer reads', () => {
  const original = opError('page_not_found', 'Page not found: notes/alpha-example', 'Check the slug.', {
    fix: { argv: ['gbrain', 'get', 'notes/alpha-example', '--include-deleted'], consent: [], actor: 'agent', requires_exclusive: false, why: 'Shows deleted pages too.' },
  });
  const revived = reviveOperationError(JSON.parse(JSON.stringify(serializeOperationError(original))));
  expect(revived).toBeInstanceOf(OperationError);
  expect(revived.toJSON()).toEqual(original.toJSON());
  expect({ ...revived }).toEqual({ ...original });
});

test('serve.cli_socket joins the connect-time config merge from its bulk snapshot only, never a read of its own', async () => {
  const base: GBrainConfig = { engine: 'postgres' };
  const reads: string[] = [];
  const reader = (table: Record<string, string> | null) => ({
    getConfig: async (key: string) => { reads.push(key); return table?.[key] ?? null; },
    ...(table ? { getAllConfig: async () => ({ ...table }) } : {}),
  });
  expect((await loadConfigWithEngine(reader({ 'serve.cli_socket': ' Yes ' }), base))?.serve_cli_socket).toBe(true);
  expect((await loadConfigWithEngine(reader({ 'serve.cli_socket': 'false' }), base))?.serve_cli_socket).toBe(false);
  expect((await loadConfigWithEngine(reader({}), base))?.serve_cli_socket).toBeUndefined();
  expect(reads).toEqual([]);
  const perKey = await loadConfigWithEngine({ getConfig: async (key: string) => { reads.push(key); return key === 'serve.cli_socket' ? 'true' : null; } }, base);
  expect(perKey?.serve_cli_socket).toBeUndefined();
  expect(reads.length).toBeGreaterThan(0);
  expect(reads).not.toContain('serve.cli_socket');
});
