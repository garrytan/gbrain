/**
 * The agent-facing CLI on a Rust-engine brain against the same CLI on a PGLite brain.
 *
 * One synthetic fixture brain (test/fixtures/rust-cli-parity-brain, 20 pages with frontmatter, tags, aliases, links
 * and timeline lines) is written into two brains through the real CLI entry (`src/cli.ts`, one child process per
 * command): `import --no-embed`, then `extract all --source db`. One brain's config says `engine: 'pglite'`, the
 * other's says `engine: 'rust'` (the opt-in engine value). Then every read command below runs with `--json` on both
 * brains, and the parsed JSON is compared after what no two runs can share is normalised: time stamps, UUIDs, row ids
 * timings, clock-derived values and each brain's temp path (the rules of test/rust-engine-differential.test.ts),
 * and fractions agree to one part in a million (clock-decayed scores move between runs milliseconds apart).
 *
 * When a setup write is refused on the Rust brain (the typed refusal), the Rust brain does not hold the fixture, and
 * comparing its reads with the full PGLite brain would only report the missing pages. A third brain, the mirror,
 * is then the reference: a PGLite brain that ran only the setup writes the Rust brain completed. Both hold the same
 * data, so each read must still answer the same way (exit code and JSON); the table marks those rows `vs mirror`.
 * The full PGLite brain still runs every command, so the fixture and the command list stay checked.
 *
 * Each command ends in one of three states:
 *  - `equal`: the Rust brain printed the same JSON as the reference brain, value for value.
 *  - `refused`: the command failed with the typed `engine_capability_missing` refusal; the table names the member.
 *  - `diverged`: anything else (other JSON, an untyped error, output that is not JSON). The test fails on it: a
 *    wrong answer is never acceptable.
 *
 * A build whose CLI cannot select the Rust engine at all (it reports `Unknown engine type: "rust"`) has no Rust arm:
 * every command is listed as `no-engine` and only the PGLite half runs, so the fixture and the command list stay
 * checked. The table goes to stdout at the end of the file.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 * 1. Protects: the agent-facing contract of the read commands, end to end (flag parsing, operation dispatch, engine
 *    members, JSON rendering), on a Rust brain.
 * 2. Fails when: a Rust member answers a command differently from PGLite (or from the mirror when a setup write was
 *    refused), or a refusal is untyped or a near answer. Doctor on a Rust brain is checked where its refused checks
 *    learn to warn (the capability-refusal slice), not here.
 * 3. Existing coverage: the engine parity suite (test/engine-parity/) compares single members in process; nothing
 *    compares whole CLI commands, where several members and the operation layer combine.
 * 4. Seams: none. It runs the real CLI and needs the addon `bun run rust:build` writes; it skips without it
 *    (GBRAIN_TEST_REQUIRE_RUST_ADDON=1 makes a missing addon an error).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';

const ROOT = resolve(import.meta.dir, '..');
const CLI = join(ROOT, 'src', 'cli.ts');
const FIXTURE = join(ROOT, 'test', 'fixtures', 'rust-cli-parity-brain');
const TARGET = detectAddonTarget();
const ADDON = TARGET ? join(ROOT, 'rust', 'target', 'addon', `gbrain_engine.${TARGET}.node`) : '';
const HAVE_ADDON = !!TARGET && existsSync(ADDON);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_REQUIRE_RUST_ADDON === '1') {
  throw new Error(`GBRAIN_TEST_REQUIRE_RUST_ADDON=1 but ${ADDON || 'no addon target'} does not exist; run bun run rust:build`);
}

type Backend = 'pglite' | 'rust';
interface Brain { backend: Backend; home: string; db: string }
type BrainName = Backend | 'mirror';
interface Run { exitCode: number; stdout: string; stderr: string }

let root = '';
const brains = {} as Record<BrainName, Brain>;
/** Set when a Rust setup write was refused: reads are then compared with the mirror, not the full PGLite brain. */
let useMirror = false;

function childEnv(brain: Brain): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) out[key] = value;
  for (const key of Object.keys(out)) {
    if (/^(DATABASE_URL|GBRAIN_DATABASE_URL|GBRAIN_BRAIN_ID|GBRAIN_SOURCE|GBRAIN_RUST_ENGINE_ADDON)$/.test(key)) delete out[key];
    if (/(_API_KEY|_API_TOKEN)(__|$)/.test(key)) delete out[key]; // keyless: no provider is ever called
  }
  return {
    ...out,
    HOME: brain.home,
    GBRAIN_HOME: brain.home,
    GBRAIN_SELF_UPGRADE_MODE: 'off',
    GBRAIN_SKIP_STARTUP_HOOKS: '1',
    GBRAIN_SWEEP: '0',
    TZ: 'UTC',
    ...(brain.backend === 'rust' ? { GBRAIN_RUST_ENGINE_ADDON: ADDON } : {}),
  };
}

async function cli(brain: Brain, args: string[]): Promise<Run> {
  const proc = Bun.spawn(['bun', 'run', CLI, ...args], { cwd: root, env: childEnv(brain), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exitCode };
}

function makeBrain(backend: Backend, name: BrainName = backend): Brain {
  const home = join(root, name, 'home');
  const db = join(root, name, 'db');
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: backend, database_path: db }));
  return { backend, home, db };
}

// ---- normalisation (what two runs cannot share) ----------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A full wall-clock instant. The fixture holds calendar days only, so every such string is a run's clock. */
const INSTANT = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;
/** Wall-clock stamps by key (the keys of test/rust-engine-differential.test.ts, plus first_seen). */
const TIMESTAMP_KEY = /(^|_)(created_at|updated_at|updated_at_iso|deleted_at|snapshot_at|ingested_at|embedded_at|last_written_at|last_sync_at|last_checked|first_seen)$/;
/** Timings and values read off the clock (how long ago "now" a page changed). */
const CLOCK_KEY = /(^|_)(latency_ms|duration_ms|duration_s|elapsed_ms|took_ms|days_since_effective)$/;
/** Row ids: serial numbers that follow insert order, never the brain's content. */
const ID_KEY = /^(id|page_id|event_page_id|chunk_id)$/;

/** The JSON with run-specific values replaced; `paths` maps this brain's temp paths to a shared placeholder. */
function normalize(value: unknown, paths: Array<[string, string]>, key = ''): unknown {
  if (value === null || value === undefined) return value === null ? null : '<undefined>';
  if (typeof value === 'string') {
    if (UUID.test(value)) return '<uuid>';
    if (TIMESTAMP_KEY.test(key) || INSTANT.test(value)) return '<timestamp>';
    return paths.reduce((text, [path, mark]) => text.split(path).join(mark), value);
  }
  if (typeof value === 'number') {
    if (ID_KEY.test(key)) return '<id>';
    if (CLOCK_KEY.test(key)) return '<clock>';
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => normalize(item, paths, key));
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(obj).sort().map((k) => [k, normalize(obj[k], paths, k)]));
  }
  return value;
}

const pathsOf = (brain: Brain): Array<[string, string]> => [[brain.db, '<db>'], [brain.home, '<home>'], [root, '<root>']];

/**
 * Same normalised JSON. Fractions may differ by one part in a million: scores that decay with the clock (salience,
 * whoknows recency) move between two runs a few milliseconds apart. Integers, strings and order compare exactly.
 */
function same(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isInteger(a) && Number.isInteger(b)) return a === b;
    return Math.abs(a - b) <= 1e-6 * Math.max(Math.abs(a), Math.abs(b));
  }
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k, i) => k === kb[i] && same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return a === b;
}

/** stdout parsed as JSON, or undefined when it is not JSON. */
function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

/** The member a typed `engine_capability_missing` refusal names, or null when the output is not that refusal. */
function refusedMember(run: Run): string | null {
  if (run.exitCode === 0) return null;
  const body = parseJson(run.stdout) as { code?: string; error?: string; detail?: string; message?: string } | undefined;
  const code = body?.code ?? body?.error;
  if (code !== 'engine_capability_missing') return null;
  const fromDetail = /member=(\S+)/.exec(body?.detail ?? '')?.[1];
  const fromMessage = /does not support (\S+) yet/.exec(body?.message ?? '')?.[1];
  return fromDetail ?? fromMessage ?? 'unknown member';
}

/** The CLI of this build cannot select the Rust engine (no `rust` engine value yet). */
function engineMissing(run: Run): boolean {
  return run.exitCode !== 0 && /Unknown engine type: \\?"rust\\?"/.test(run.stdout + run.stderr);
}

// ---- the commands ----------------------------------------------------------------------------------------------

/** Writes that build each brain, in order. Their outcome is reported, never compared. */
const SETUP: string[][] = [
  ['import', FIXTURE, '--no-embed', '--json'],
  ['extract', 'all', '--source', 'db', '--json'],
];

/** Every read command with `--json` that runs keyless on the fixture. */
const COMMANDS: string[][] = [
  ['get', 'people/alice-example', '--json'],
  ['get', 'companies/acme-example', '--json'],
  ['list', '--json'],
  ['list', '--type', 'person', '--json'],
  ['list', '--tag', 'search', '--json'],
  ['find', 'people/*', '--json'],
  ['find', 'acme', '--json'],
  ['search', 'keyword', '--match', 'keyword', '--json'],
  ['search', 'graph memory', '--match', 'keyword', '--json'],
  ['search-exact', 'graph memory', '--json'],
  ['query', 'keyword ranking', '--no-expand', '--json'],
  ['tags', 'people/alice-example', '--json'],
  ['links', 'people/alice-example', '--json'],
  ['backlinks', 'companies/acme-example', '--json'],
  ['link-sources', '--json'],
  ['graph', 'people/alice-example', '--depth', '2', '--json'],
  ['wanted', '--json'],
  ['timeline', 'companies/acme-example', '--json'],
  ['history', 'people/alice-example', '--json'],
  ['whois', 'alice', '--json'],
  ['orphans', '--json'],
  ['rank-entities', '--json'],
  ['entity', 'Alice Example', '--json'],
  ['recall', 'people/alice-example', '--json'],
  ['salience', '--json'],
  ['anomalies', '--json'],
  ['day', '--date', '2026-03-02', '--json'],
  ['on-this-day', '--date', '2026-03-02', '--json'],
  ['since', '--date', '2026-01-01', '--json'],
  ['last-seen', '--entity', 'people/alice-example', '--json'],
  ['stats', '--json'],
  ['stats', '--by', 'source,type', '--json'],
  ['health', '--json'],
  ['sources', 'list', '--json'],
  ['whoami', '--json'],
  ['extraction-pending', '--json'],
  ['whoknows', 'search', '--json'],
];

type State = 'equal' | 'refused' | 'diverged' | 'no-engine';
interface Row { command: string; state: State; note: string }
const table: Row[] = [];
const setupRows: Row[] = [];
let rustArm: 'on' | 'no-engine' = 'on';

const label = (args: string[]) => args.map((a) => (a === FIXTURE ? '<fixture>' : /\s/.test(a) ? JSON.stringify(a) : a)).join(' ');

function printTable(): void {
  const lines = ['[rust cli parity] setup:', ...setupRows.map((r) => `  ${r.command} | ${r.state}${r.note ? ` (${r.note})` : ''}`),
    '[rust cli parity] commands:', ...table.map((r) => `  ${r.command} | ${r.state}${r.note ? ` (${r.note})` : ''}`)];
  const count = (s: State) => table.filter((r) => r.state === s).length;
  if (useMirror) lines.push('[rust cli parity] a Rust setup write was refused: reads were compared with the mirror (PGLite with the same completed writes)');
  lines.push(`[rust cli parity] ${count('equal')} equal, ${count('refused')} refused, ${count('diverged')} diverged, ${count('no-engine')} without a Rust engine`);
  console.log(lines.join('\n'));
}

describe.skipIf(!HAVE_ADDON)('the CLI on a Rust brain answers like the CLI on a PGLite brain', () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'gb-rust-cli-parity-'));
    brains.pglite = makeBrain('pglite');
    brains.rust = makeBrain('rust');
    brains.mirror = makeBrain('pglite', 'mirror');
    for (const args of SETUP) {
      const [pg, rust] = await Promise.all([cli(brains.pglite, args), cli(brains.rust, args)]);
      if (pg.exitCode !== 0) throw new Error(`PGLite setup ${label(args)} failed (${pg.exitCode}): ${pg.stdout}\n${pg.stderr}`);
      if (engineMissing(rust)) { rustArm = 'no-engine'; setupRows.push({ command: label(args), state: 'no-engine', note: 'the CLI has no rust engine value' }); continue; }
      if (rust.exitCode === 0) {
        const mirror = await cli(brains.mirror, args);
        if (mirror.exitCode !== 0) throw new Error(`mirror setup ${label(args)} failed (${mirror.exitCode}): ${mirror.stdout}\n${mirror.stderr}`);
      } else {
        useMirror = true;
      }
      const member = refusedMember(rust);
      setupRows.push({ command: label(args), state: rust.exitCode === 0 ? 'equal' : member ? 'refused' : 'diverged', note: rust.exitCode === 0 ? 'ran' : member ?? rust.stdout.slice(0, 300) + rust.stderr.slice(0, 300) });
    }
  }, 600_000);

  afterAll(() => {
    printTable();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test('setup never ends in an untyped Rust failure', () => {
    expect(setupRows.filter((r) => r.state === 'diverged')).toEqual([]);
  });

  test('the CLI selects the Rust engine (a build without it must fail here, not pass as no-engine)', () => {
    // The addon is present (this block skips without it), so every setup row ran on the Rust brain.
    expect(rustArm).toBe('on');
    expect(setupRows.filter((r) => r.state === 'no-engine')).toEqual([]);
  });

  for (const args of COMMANDS) {
    test(label(args), async () => {
      const [pg, rust] = await Promise.all([cli(brains.pglite, args), rustArm === 'on' ? cli(brains.rust, args) : Promise.resolve(null)]);
      const pgJson = parseJson(pg.stdout);
      // The PGLite answer is the reference: it must succeed with JSON on stdout.
      expect({ exitCode: pg.exitCode, json: pgJson !== undefined, stderr: pg.exitCode === 0 ? '' : pg.stderr }).toEqual({ exitCode: 0, json: true, stderr: '' });
      if (!rust || engineMissing(rust)) {
        table.push({ command: label(args), state: 'no-engine', note: '' });
        return;
      }
      const member = refusedMember(rust);
      if (member) {
        table.push({ command: label(args), state: 'refused', note: member });
        return;
      }
      const ref = useMirror ? await cli(brains.mirror, args) : pg;
      const refBrain = useMirror ? brains.mirror : brains.pglite;
      const asJson = (run: Run, brain: Brain) => {
        const json = parseJson(run.stdout);
        return normalize(json === undefined ? `${run.stdout}\n${run.stderr}` : json, pathsOf(brain));
      };
      const want = { exitCode: ref.exitCode, json: asJson(ref, refBrain) };
      const got = { exitCode: rust.exitCode, json: asJson(rust, brains.rust) };
      const equal = got.exitCode === want.exitCode && same(got.json, want.json);
      const notes = [useMirror ? 'vs mirror' : '', equal && ref.exitCode !== 0 ? `both exit ${ref.exitCode}` : '', equal ? '' : `exit ${rust.exitCode}`].filter(Boolean);
      table.push({ command: label(args), state: equal ? 'equal' : 'diverged', note: notes.join(', ') });
      // A wrong answer is never acceptable: the Rust brain refuses with a typed refusal or answers exactly.
      if (!equal) expect(got).toEqual(want);
    }, 240_000);
  }
});
