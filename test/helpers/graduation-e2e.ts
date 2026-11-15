/**
 * Shared machinery for the engine graduation E2E suites (PGLite -> Postgres).
 *
 * Everything drives the real CLI (`bun src/cli.ts migrate ...`) in child
 * processes with an isolated HOME/GBRAIN_HOME, so the CLI's own connect path,
 * kernel lock and exit codes are what the tests observe. Crash and pause
 * points come from test/helpers/graduation-hooks-preload.ts, loaded with
 * `bun --preload`, which stops the child at a named custody boundary.
 *
 * Contract reads (plan hash, code, fix argv, state) go through the accessors
 * below so a field-name change in the CLI's JSON is fixed in one place.
 */
import { test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import postgres from '#postgres';
import { assertSafeE2eDatabaseUrl } from './db-guard.ts';
import { gbrain, planHashOf, REPO, type GbrainChild, type GbrainOpts, type GbrainResult } from '../../scripts/persistence/graduation-process.ts';

export * from '../../scripts/persistence/graduation-process.ts';

/** Graduation E2E tests: plain `test`, kept as a named alias so suites read the same. */
export const graduationTest: typeof test = test;
/** `graduationTest` with an extra visible skip condition (e.g. Docker unavailable). */
export function graduationTestIf(skip: boolean): typeof test {
  return test.skipIf(skip) as typeof test;
}
export const DATABASE_URL = process.env.DATABASE_URL;

// ── Boundary events ───────────────────────────────────────────────────────────

export interface BoundaryEvent { event: 'boundary' | 'paused' | 'released'; boundary: string; detail: Record<string, unknown>; pid: number; at: number; ordinal?: number }

/**
 * Events written so far. The child appends while the parent polls, so the text after the last
 * newline may be a half-written line: it is left for the next poll. Every newline-terminated
 * line must parse; a malformed one is a real failure.
 */
export function readEvents(path: string): BoundaryEvent[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf8').split('\n');
  lines.pop();
  return lines.filter(Boolean).map((line, i) => {
    try { return JSON.parse(line) as BoundaryEvent; }
    catch (error) { throw new Error(`${path} line ${i + 1} is not a JSON event (${(error as Error).message}): ${line.slice(0, 200)}`); }
  });
}

/** Wait for a `paused` event (or any event matching `match`) while the child lives. */
export async function waitForEvent(path: string, match: (e: BoundaryEvent) => boolean, child: GbrainChild, timeoutMs = 300_000): Promise<BoundaryEvent> {
  const deadline = Date.now() + timeoutMs;
  let done = false;
  let result: GbrainResult | null = null;
  child.exited.then(r => { done = true; result = r; });
  for (;;) {
    const hit = readEvents(path).find(match);
    if (hit) return hit;
    if (done) throw new Error(`child exited (${result!.code}/${result!.signal}) before the expected boundary\nstdout:${result!.stdout.slice(-2000)}\nstderr:${result!.stderr.slice(-4000)}`);
    if (Date.now() > deadline) throw new Error(`timed out waiting for a boundary in ${path}`);
    await Bun.sleep(25);
  }
}

export function release(path: string, ordinal: number): void {
  writeFileSync(`${path}.release.${ordinal}`, '');
}

// ── Postgres targets ──────────────────────────────────────────────────────────

export interface TargetDb { url: string; database: string; admin: string; close(): Promise<void> }

function withDatabase(url: string, database: string, user?: { name: string; password: string }): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  if (user) { u.username = user.name; u.password = user.password; }
  return u.toString();
}

/** A brand-new empty database (no gbrain schema) on the E2E server. */
export async function emptyTarget(adminUrl = DATABASE_URL!): Promise<TargetDb> {
  assertSafeE2eDatabaseUrl(adminUrl);
  const database = `gbrain_test_graduation_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const admin = postgres(adminUrl, { max: 1, prepare: false, onnotice: () => {} });
  try { await admin.unsafe(`CREATE DATABASE ${database}`); } finally { await admin.end(); }
  return { url: withDatabase(adminUrl, database), database, admin: adminUrl, close: () => dropDatabase(adminUrl, database) };
}

export async function dropDatabase(adminUrl: string, database: string): Promise<void> {
  const admin = postgres(adminUrl, { max: 1, prepare: false, onnotice: () => {} });
  try { await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); } finally { await admin.end(); }
}

/**
 * A hosted-style target: a NOSUPERUSER LOGIN role that owns an empty database
 * whose `vector` extension the administrator created (as managed providers
 * do). The role cannot `SET session_replication_role`, so the copy must use
 * the `DISABLE TRIGGER USER` fallback.
 */
export async function hostedRoleTarget(adminUrl = DATABASE_URL!): Promise<TargetDb & { role: string; rotatePassword(): Promise<string> }> {
  assertSafeE2eDatabaseUrl(adminUrl);
  const suffix = randomUUID().replace(/-/g, '').slice(0, 16);
  const role = `gbrain_hosted_${suffix}`;
  const database = `gbrain_test_graduation_hosted_${suffix}`;
  let password = `hosted-${randomUUID()}`;
  const admin = postgres(adminUrl, { max: 1, prepare: false, onnotice: () => {} });
  try {
    // BYPASSRLS like a managed provider's application role (Supabase `postgres`): the schema's RLS backfill needs it.
    await admin.unsafe(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS PASSWORD '${password}'`);
    await admin.unsafe(`CREATE DATABASE ${database} OWNER ${role}`);
  } finally { await admin.end(); }
  const owned = postgres(withDatabase(adminUrl, database), { max: 1, prepare: false, onnotice: () => {} });
  try {
    await owned.unsafe('CREATE EXTENSION IF NOT EXISTS vector');
    await owned.unsafe('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    await owned.unsafe(`GRANT ALL ON SCHEMA public TO ${role}`);
    // The auto-RLS event trigger is superuser-only; managed providers pre-create it with the function owned by the app role.
    await owned.unsafe(`CREATE OR REPLACE FUNCTION public.auto_enable_rls() RETURNS event_trigger LANGUAGE plpgsql AS $f$ DECLARE obj record; BEGIN
      FOR obj IN SELECT * FROM pg_event_trigger_ddl_commands() WHERE object_type = 'table' AND schema_name = 'public' LOOP
        EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', obj.object_identity); END LOOP; END; $f$`);
    await owned.unsafe(`ALTER FUNCTION public.auto_enable_rls() OWNER TO ${role}`);
    await owned.unsafe(`CREATE EVENT TRIGGER auto_rls_on_create_table ON ddl_command_end WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO') EXECUTE FUNCTION public.auto_enable_rls()`);
  } finally { await owned.end(); }
  return {
    role, database, admin: adminUrl,
    get url() { return withDatabase(adminUrl, database, { name: role, password }); },
    async rotatePassword() {
      password = `rotated-${randomUUID()}`;
      const a = postgres(adminUrl, { max: 1, prepare: false, onnotice: () => {} });
      try { await a.unsafe(`ALTER ROLE ${role} PASSWORD '${password}'`); } finally { await a.end(); }
      return withDatabase(adminUrl, database, { name: role, password });
    },
    async close() {
      await dropDatabase(adminUrl, database);
      const a = postgres(adminUrl, { max: 1, prepare: false, onnotice: () => {} });
      try { await a.unsafe(`DROP ROLE IF EXISTS ${role}`); } finally { await a.end(); }
    },
  } as TargetDb & { role: string; rotatePassword(): Promise<string> };
}

/** The same database reached through the transaction-mode pooler (GBRAIN_PGBOUNCER_URL), or null when no pooler is configured. */
export function pooledUrl(target: TargetDb): string | null {
  const pooler = process.env.GBRAIN_PGBOUNCER_URL;
  return pooler ? withDatabase(pooler, target.database) : null;
}

// ── Zero-mutation digests ─────────────────────────────────────────────────────

export interface StateDigest { files: Record<string, string>; target: Record<string, string> }

function digestFiles(root: string, out: Record<string, string>): void {
  if (!existsSync(root)) return;
  const info = lstatSync(root);
  if (info.isSymbolicLink()) { out[root] = `link`; return; }
  if (info.isFile()) { out[root] = `${info.mode.toString(8)}:${createHash('sha256').update(readFileSync(root)).digest('hex')}`; return; }
  if (!info.isDirectory()) return;
  out[root] = `dir:${info.mode.toString(8)}`;
  for (const name of readdirSync(root).sort()) digestFiles(join(root, name), out);
}

/**
 * Every file under the fixture directory (home, config, manifest, intent
 * marker, tombstone, data dir and its siblings) plus, when a target URL is
 * given, every target relation's rows, sequences and trigger enablement.
 */
export async function stateDigest(fixtureDir: string, targetUrl?: string): Promise<StateDigest> {
  const files: Record<string, string> = {};
  digestFiles(fixtureDir, files);
  const target: Record<string, string> = {};
  if (targetUrl) {
    const sql = postgres(targetUrl, { max: 1, prepare: false, onnotice: () => {} });
    try {
      const relations = await sql.unsafe<{ name: string; kind: string }[]>(`SELECT c.relname AS name, c.relkind::text AS kind FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','S','v') ORDER BY c.relname COLLATE "C"`);
      target['@relations'] = relations.map((r: { name: string; kind: string }) => `${r.kind}:${r.name}`).join(',');
      for (const r of relations) {
        if (r.kind === 'v') continue;
        const [row] = r.kind === 'S'
          ? await sql.unsafe(`SELECT last_value::text || ':' || is_called::text AS d FROM "${r.name}"`)
          : await sql.unsafe(`SELECT count(*)::text || ':' || md5(coalesce(string_agg(t::text, E'\\n' ORDER BY t::text COLLATE "C"), '')) AS d FROM "${r.name}" t`);
        target[r.name] = String(row.d);
      }
      const triggers = await sql.unsafe<{ d: string }[]>(`SELECT c.relname || '.' || t.tgname || '=' || t.tgenabled::text AS d FROM pg_trigger t
        JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal ORDER BY 1`);
      target['@triggers'] = triggers.map((t: { d: string }) => t.d).join(',');
    } catch (error) {
      if ((error as { code?: string }).code !== '3D000') throw error;
      target['@database'] = 'absent';
    } finally { await sql.end(); }
  }
  return { files, target };
}

export function digestChanges(before: StateDigest, after: StateDigest): string[] {
  const changes: string[] = [];
  for (const side of ['files', 'target'] as const) {
    const keys = new Set([...Object.keys(before[side]), ...Object.keys(after[side])]);
    for (const key of [...keys].sort()) if (before[side][key] !== after[side][key]) changes.push(`${side} ${key}: ${before[side][key] ?? '(absent)'} -> ${after[side][key] ?? '(absent)'}`);
  }
  return changes;
}

// ── Common flows ──────────────────────────────────────────────────────────────

export const TARGET_ENV = 'GBRAIN_TARGET_URL';

/** The two-command agent flow: plan (exit 3, ask_user) then `--yes --expect <hash>`. */
export async function graduateViaAgentFlow(home: string, url: string, opts: { extra?: string[]; env?: Record<string, string>; hooks?: GbrainOpts['hooks'] } = {}) {
  const env = { [TARGET_ENV]: url, ...opts.env };
  const plan = await gbrain(['migrate', '--to', 'postgres', '--url-env', TARGET_ENV, '--json', ...(opts.extra ?? [])], { home, env });
  const hash = planHashOf(plan.json);
  const run = hash ? await gbrain(['migrate', '--to', 'postgres', '--url-env', TARGET_ENV, '--yes', '--expect', hash, '--json', ...(opts.extra ?? [])],
    { home, env, hooks: opts.hooks, timeoutMs: 1_800_000 }) : null;
  return { plan, hash, run };
}

/**
 * The byte pattern that proves a password leaked. A distinctive password is searched for raw; a short or
 * common one (CI's `postgres:postgres`) appears legitimately in redacted URLs and paths, so only its
 * URL-credential form `:<password>@` counts.
 */
export function leakNeedle(password: string): string {
  return password.length >= 12 && !/^(postgres|test|password)/i.test(password) ? password : `:${encodeURIComponent(password)}@`;
}

/** Assert no output byte names the target password (stdout, stderr, files under the fixture except the 0600 manifest and config). */
export function passwordLeaks(password: string, results: GbrainResult[], fixtureDir: string): string[] {
  const leaks: string[] = [];
  const needle = leakNeedle(password);
  for (const [i, r] of results.entries()) {
    if (r.stdout.includes(needle)) leaks.push(`result ${i} stdout`);
    if (r.stderr.includes(needle)) leaks.push(`result ${i} stderr`);
  }
  const allowed = new Set(['graduation-manifest.json', 'config.json']);
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const info = lstatSync(path);
      if (info.isDirectory()) { if (!name.endsWith('.pglite') && !name.includes('.graduated-') && name !== '.git') walk(path); continue; }
      if (!info.isFile() || info.size > 4 * 1024 * 1024 || allowed.has(name)) continue;
      if (readFileSync(path).includes(needle)) leaks.push(path);
    }
  };
  walk(fixtureDir);
  return leaks;
}

export function passwordOf(url: string): string {
  return decodeURIComponent(new URL(url).password);
}

/** Sibling paths of a data dir that graduation custody creates. */
export function custodyPaths(dataDir: string) {
  const parent = dirname(dataDir);
  const name = dataDir.slice(parent.length + 1);
  const graduated = existsSync(parent) ? readdirSync(parent).filter(n => n.startsWith(`${name}.graduated-`)).map(n => join(parent, n)) : [];
  return {
    marker: `${dataDir}.gbrain-graduation.json`,
    graduated,
    tombstone: existsSync(dataDir) && statSync(dataDir).isFile() ? dataDir : null,
    dataDirIsDirectory: existsSync(dataDir) && statSync(dataDir).isDirectory(),
  };
}

export function manifestPath(home: string): string {
  return join(home, '.gbrain', 'graduation-manifest.json');
}

// ── Older released binaries ───────────────────────────────────────────────────

/** The last `count` release tags at or below this checkout's VERSION, newest first (from origin). */
/** The first release that knows engine graduation (its intent marker, source row and tombstone). */
export const FIRST_GRADUATION_RELEASE = '0.60.52.0';

/**
 * The newest released tags that predate engine graduation: binaries that know nothing of the
 * marker, the source row or the tombstone. A graduation-aware release refuses where these tests
 * need an unaware writer, so the newest tags at or after FIRST_GRADUATION_RELEASE never qualify.
 */
export function previousReleaseTags(count = 2, bound: NetworkBound = {}): string[] {
  const version = [readFileSync(join(REPO, 'VERSION'), 'utf8').trim(), FIRST_GRADUATION_RELEASE]
    .sort((a, b) => cmpVersion(a.split('.').map(Number), b.split('.').map(Number)))[0]!;
  const out = networkGit(['ls-remote', '--tags', '--refs', 'origin', 'v*'], bound);
  const parse = (tag: string) => tag.slice(1).split('.').map(Number);
  const cmp = (a: number[], b: number[]) => { for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] ?? 0) - (b[i] ?? 0); if (d) return d; } return 0; };
  const current = version.split('.').map(Number);
  return out.split('\n').map(line => line.split('refs/tags/')[1]).filter((t): t is string => !!t && /^v\d+(\.\d+){3}$/.test(t))
    .filter(t => cmp(parse(t), current) < 0).sort((a, b) => cmp(parse(b), parse(a))).slice(0, count);
}

/** Each network git call's own bound: a connection that opens and never answers must not hold the suite's beforeAll to its 900 s limit. */
export interface NetworkBound { timeoutMs?: number; attempts?: number }

/** `git -C REPO <args>` against origin, killed after `timeoutMs` and retried up to `attempts` times; throws naming the last failure. */
function networkGit(args: string[], { timeoutMs = 60_000, attempts = 3 }: NetworkBound = {}): string {
  let last = '';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const r = Bun.spawnSync(['git', '-C', REPO, ...args], { stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    if (r.exitCode === 0) return r.stdout.toString();
    last = r.exitedDueToTimeout ? `timed out after ${timeoutMs / 1000}s` : `exit ${r.exitCode}: ${r.stderr.toString().trim().slice(-500)}`;
  }
  throw new Error(`git ${args.join(' ')} failed ${attempts} time(s); last: ${last}. The older-release binaries need origin reachable; `
    + 'prebuild them under GBRAIN_OLDER_RELEASE_DIR or point GBRAIN_OLDER_RELEASE_BIN_<tag> at one.');
}

function cmpVersion(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] ?? 0) - (b[i] ?? 0); if (d) return d; }
  return 0;
}

/**
 * A compiled binary of an older release, built once per tag into the cache
 * (`GBRAIN_OLDER_RELEASE_DIR`, default ~/.cache/gbrain-older-releases).
 * `GBRAIN_OLDER_RELEASE_BIN_<tag with dots as underscores>` points at a prebuilt one.
 */
export function olderReleaseBinary(tag: string, bound: NetworkBound = {}): string {
  const preset = process.env[`GBRAIN_OLDER_RELEASE_BIN_${tag.replace(/\./g, '_')}`];
  if (preset) return preset;
  const cache = process.env.GBRAIN_OLDER_RELEASE_DIR || join(process.env.HOME ?? '/tmp', '.cache', 'gbrain-older-releases');
  const tree = join(cache, tag);
  const binary = join(tree, 'bin', 'gbrain');
  if (existsSync(binary)) return binary;
  const run = (argv: string[], cwd = REPO) => {
    const r = Bun.spawnSync(argv, { cwd, stdout: 'pipe', stderr: 'pipe', timeout: 300_000 });
    if (r.exitCode !== 0) throw new Error(`${argv.join(' ')}: ${r.exitedDueToTimeout ? 'timed out after 300s' : r.stderr.toString().slice(-2000)}`);
  };
  const local = Bun.spawnSync(['git', '-C', REPO, 'rev-parse', '-q', '--verify', `refs/tags/${tag}`], { stdout: 'pipe', stderr: 'pipe' });
  if (local.exitCode !== 0) networkGit(['fetch', '-q', 'origin', 'tag', tag, '--no-tags'], bound);
  if (!existsSync(tree)) run(['git', 'worktree', 'add', '-q', '--detach', tree, tag]);
  run([process.execPath, 'install', '--frozen-lockfile', '--ignore-scripts'], tree);
  run([process.execPath, 'build', '--compile', '--no-compile-autoload-bunfig', '--outfile', 'bin/gbrain', 'src/cli.ts'], tree);
  return binary;
}
