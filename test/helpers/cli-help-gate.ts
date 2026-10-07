/**
 * Shared harness for the help gate (#6114): `--help`, `-h` and a bare
 * `help` must never perform the command. Each case runs the real CLI in a
 * child process against a copy of one pre-seeded PGLite brain, offline and
 * keyless, with the child-side probe (cli-side-effect-probe.ts) recording
 * any fetch or spawn, and asserts the brain (logically: table contents), the
 * HOME/cwd tree and the probe log are unchanged.
 *
 * The cases are partitioned across several serial files (the serial runner
 * kills one file after 300 s), each running GATE_PARTS-th of the list.
 */
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { CLI_COMMANDS } from '../../src/cli/command-table.ts';
import { ROUTERS } from '../../src/cli/subcommands.ts';
import { STRICT_SUBCOMMANDS } from '../../src/cli/strict-args.ts';

export const GATE_PARTS = 4;
const REPO = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const PROBE = join(REPO, 'test/helpers/cli-side-effect-probe.ts');
/** Files any run may touch without acting: the agent-contract event log is written by the error/exit seam. */
const TREE_ALLOW = [/^\.gbrain\/agent-contract\//];
/** Bookkeeping a brain connection writes (managed-root registration, the behavior-notice baseline): allowed only for cases that connect on purpose. */
const CONNECT_ALLOW = [/^\.gbrain\/persistence\/managed-roots\//, /^\.gbrain\/notices\/behavior-changes\//];

export interface GateCase {
  argv: string[];
  /** Expected exit code. */
  exit: number;
  /** A string stdout must contain (help cases: the usage), or null. */
  stdout?: string | null;
  /** A string stdout must NOT contain. */
  notStdout?: string;
  /** Run with the test-environment startup suppression removed (NODE_ENV, GBRAIN_SKIP_STARTUP_HOOKS). */
  unsuppressed?: boolean;
  /** Skip the brain/tree comparison (a non-help case that legitimately writes, e.g. a search's telemetry). */
  mayWrite?: boolean;
  /** A non-help case that connects to the brain: connection bookkeeping files may change, nothing else. */
  connects?: boolean;
}

/** The usage marker each router prints. */
const ROUTER_USAGE: Record<string, string> = {
  pages: 'gbrain pages —', cache: 'gbrain cache —', integrity: 'Usage: gbrain integrity', hook: 'Usage: gbrain hook',
  search: 'Usage: gbrain search <modes', 'edge-proposals': 'Usage: gbrain edge-proposals', schema: 'gbrain schema —',
  config: 'Usage: gbrain config',
};

/** Every case, in a stable order. */
export function allGateCases(): GateCase[] {
  const cases: GateCase[] = [];
  for (const rec of CLI_COMMANDS) {
    if (!rec.selfHelp) continue;
    cases.push({ argv: [rec.name, '--help'], exit: 0, stdout: null, unsuppressed: true });
    cases.push({ argv: [rec.name, '-h'], exit: 0, stdout: null });
  }
  for (const [command, router] of Object.entries(ROUTERS)) {
    const usage = ROUTER_USAGE[command]!;
    if (router.bareHelpFirst) cases.push({ argv: [command, 'help'], exit: 0, stdout: usage });
    for (const sub of router.subcommands) {
      for (const h of ['--help', '-h', 'help']) cases.push({ argv: [command, sub, h], exit: 0, stdout: usage });
    }
  }
  cases.push(
    { argv: ['pages', 'purge-deleted', '--older-than', '--help'], exit: 0, stdout: ROUTER_USAGE.pages },
    { argv: ['pages', 'purge-deleted', '--older-than', 'help'], exit: 2 },
    { argv: ['pages', 'purge-deleted', '--source', 'nonexistent'], exit: 2 },
    { argv: ['pages', 'purge-deleted', '--older-than'], exit: 2 },
    { argv: ['pages', 'purge-deleted', '--older-than=9999'], exit: 0, stdout: 'No pages to purge', connects: true },
    { argv: ['pages', 'purge-deleted'], exit: 3, connects: true },
    { argv: ['search', 'modes', '--reset', '--help'], exit: 0, stdout: ROUTER_USAGE.search },
    { argv: ['search', 'modes', '--reset', 'extra'], exit: 2 },
    { argv: ['search', 'tune', '--apply', '--help'], exit: 0, stdout: ROUTER_USAGE.search },
    { argv: ['cache', 'clear', '--yes', '--help'], exit: 0, stdout: ROUTER_USAGE.cache },
    { argv: ['cache', 'clear', '--yes', '--source'], exit: 2 },
    { argv: ['schema', 'downgrade', '--help'], exit: 0, stdout: ROUTER_USAGE.schema },
    { argv: ['schema', 'use', 'gbrain-base', '--help'], exit: 0, stdout: ROUTER_USAGE.schema },
    { argv: ['schema', 'use', 'gbrain-base', '--json'], exit: 2 },
    { argv: ['integrity', 'auto', '--help'], exit: 0, stdout: ROUTER_USAGE.integrity },
    { argv: ['integrity', 'reset-progress', 'now'], exit: 2 },
    { argv: ['hook', 'stop', '--help'], exit: 0, stdout: ROUTER_USAGE.hook },
    // A bare `help` in a free-text slot is a query, not a help request.
    { argv: ['search', 'help'], exit: 0, notStdout: ROUTER_USAGE.search, mayWrite: true },
  );
  // Every strict refusal's fix is a real read-only command: it runs, exits 0 and changes nothing.
  const fixes = new Set<string>();
  for (const spec of Object.values(STRICT_SUBCOMMANDS)) if ('argv' in spec.fix) fixes.add(JSON.stringify(spec.fix.argv));
  for (const f of fixes) cases.push({ argv: JSON.parse(f) as string[], exit: 0, connects: true });
  return cases;
}

export function gateCasesForPart(part: number): GateCase[] {
  return allGateCases().filter((_, i) => i % GATE_PARTS === part);
}

function offlineEnv(root: string, unsuppressed: boolean, log: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k.startsWith('GBRAIN_') || /_API_KEY$|_API_TOKEN$/.test(k) || k === 'DATABASE_URL') continue;
    env[k] = v;
  }
  Object.assign(env, { HOME: root, GBRAIN_HOME: root, GBRAIN_NON_INTERACTIVE: '1', GBRAIN_NO_RETRY_CONNECT: '1', GBRAIN_TEST_SIDE_EFFECT_LOG: log,
    // Bun's own transpiler cache, kept outside HOME so the tree comparison sees only gbrain's writes.
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(tmpdir(), 'gbrain-help-gate-bun-cache') });
  if (unsuppressed) delete env.NODE_ENV;
  else env.NODE_ENV = 'test';
  return env;
}

export async function runCli(root: string, argv: string[], unsuppressed = false): Promise<{ stdout: string; stderr: string; exitCode: number; effects: string[] }> {
  const log = join(root, '..', `${relative(tmpdir(), root).replace(/\W/g, '_')}.effects`);
  rmSync(log, { force: true });
  const proc = Bun.spawn(['bun', '--no-env-file', '--preload', PROBE, join(REPO, 'src/cli.ts'), ...argv], {
    cwd: join(root, 'work'), env: offlineEnv(root, unsuppressed, log), stdin: Bun.file('/dev/null'), stdout: 'pipe', stderr: 'pipe',
  });
  const killer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } }, 60_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    const effects = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
    return { stdout, stderr, exitCode, effects };
  } finally {
    clearTimeout(killer);
  }
}

const CONFIG = join('.gbrain', 'config.json');

/** Path → content hash for every file under `dir` (config.json with the copy's own root masked). */
function statTree(dir: string, base = dir, out = new Map<string, string>()): Map<string, string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const rel = relative(base, p);
    if (statSync(p).isDirectory()) statTree(p, base, out);
    else out.set(rel, String(Bun.hash(rel === CONFIG ? readFileSync(p, 'utf8').replaceAll(base, '<ROOT>') : readFileSync(p))));
  }
  return out;
}

/** Logical brain fingerprint: an md5 of every public table's rows. */
async function brainFingerprint(root: string): Promise<Record<string, string>> {
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: join(root, '.gbrain', 'brain.pglite') });
  try {
    const tables = await engine.executeRaw<{ t: string }>("SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1");
    const out: Record<string, string> = {};
    for (const { t } of tables) {
      const [row] = await engine.executeRaw<{ h: string | null }>(`SELECT md5(string_agg(x::text, '|' ORDER BY x::text)) AS h FROM "${t}" x`);
      out[t] = row?.h ?? '';
    }
    return out;
  } finally {
    await engine.disconnect();
  }
}

export interface GateFixture {
  template: string;
  brain: Record<string, string>;
  tree: Map<string, string>;
}

/** Build the seeded template brain once per file. */
export async function buildFixture(): Promise<GateFixture> {
  const template = mkdtempSync(join(tmpdir(), 'gbrain-help-gate-'));
  mkdirSync(join(template, 'work'));
  const init = await runCli(template, ['init', '--pglite', '--no-embedding']);
  if (init.exitCode !== 0) throw new Error(`fixture init failed: ${init.stderr}`);
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: join(template, '.gbrain', 'brain.pglite') });
  try {
    // Seed rows directly with the managed-writer guard paused, then restore it.
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw(`INSERT INTO pages (source_id, slug, type, title, deleted_at) VALUES
      ('default', 'notes/old-deleted', 'note', 'old', now() - INTERVAL '200 hours'),
      ('default', 'notes/live', 'note', 'live', NULL)`);
    await engine.setConfig('search.cache.enabled', 'false');
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  } finally {
    await engine.disconnect();
  }
  return { template, brain: await brainFingerprint(template), tree: statTree(template) };
}

export function copyFixture(fx: GateFixture, into: string): void {
  rmSync(into, { recursive: true, force: true });
  cpSync(fx.template, into, { recursive: true });
  // config.json names the brain by absolute path: point the copy at its own brain.
  const config = join(into, CONFIG);
  writeFileSync(config, readFileSync(config, 'utf8').replaceAll(fx.template, into));
}

/**
 * What changed after a case: tree paths outside the allow list and the brain
 * tables whose rows differ. The brain is compared logically only when its
 * files changed (WAL/lock churn without a row change is not a write).
 */
export async function changesSince(fx: GateFixture, root: string, connects = false): Promise<{ files: string[]; tables: string[] }> {
  const now = statTree(root);
  const changed = new Set<string>();
  for (const [p, v] of now) if (fx.tree.get(p) !== v) changed.add(p);
  for (const p of fx.tree.keys()) if (!now.has(p)) changed.add(p);
  const brainTouched = [...changed].some(p => p.startsWith('.gbrain/brain.pglite/'));
  const allow = connects ? [...TREE_ALLOW, ...CONNECT_ALLOW] : TREE_ALLOW;
  const files = [...changed].filter(p => !p.startsWith('.gbrain/brain.pglite/') && !allow.some(re => re.test(p))).sort();
  if (!brainTouched) return { files, tables: [] };
  const brain = await brainFingerprint(root);
  return { files, tables: Object.keys({ ...brain, ...fx.brain }).filter(t => brain[t] !== fx.brain[t]).sort() };
}

/** Runs `cases` on `workers` fixture copies; returns one failure line per case that acted. */
export async function runGate(fx: GateFixture, cases: GateCase[], workers = 4): Promise<string[]> {
  const failures: string[] = [];
  const queue = [...cases];
  const verbose = process.env.HELP_GATE_LOG;
  await Promise.all(Array.from({ length: workers }, async (_, w) => {
    const root = join(fx.template, '..', `${relative(tmpdir(), fx.template)}-w${w}`);
    copyFixture(fx, root);
    for (let c = queue.shift(); c; c = queue.shift()) {
      const r = await runCli(root, c.argv, c.unsuppressed);
      const problems: string[] = [];
      if (r.exitCode !== c.exit) problems.push(`exit ${r.exitCode} (want ${c.exit})`);
      if (c.stdout === null && !(r.stdout + r.stderr).trim()) problems.push('printed no usage');
      if (c.stdout && !r.stdout.includes(c.stdout)) problems.push(`stdout lacks ${JSON.stringify(c.stdout)}`);
      if (c.notStdout && r.stdout.includes(c.notStdout)) problems.push(`stdout has ${JSON.stringify(c.notStdout)}`);
      if (r.effects.length) problems.push(`side effects ${r.effects.join(' ; ')}`);
      if (!c.mayWrite) {
        const ch = await changesSince(fx, root, c.connects);
        if (ch.files.length) problems.push(`files changed ${ch.files.join(', ')}`);
        if (ch.tables.length) problems.push(`brain tables changed ${ch.tables.join(', ')}`);
      }
      if (problems.length || c.mayWrite) copyFixture(fx, root);
      const line = `gbrain ${c.argv.join(' ')}: ${problems.join('; ')}`;
      if (verbose) appendFileSync(verbose, `${problems.length ? 'FAIL' : 'ok  '} ${line}${problems.length ? `\n    stderr: ${r.stderr.trim().split('\n').slice(-2).join(' | ')}` : ''}\n`);
      if (problems.length) failures.push(line);
    }
    rmSync(root, { recursive: true, force: true });
  }));
  return failures.sort();
}
