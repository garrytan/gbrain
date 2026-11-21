/**
 * The agent-facing CLI on a Rust-engine brain against the same CLI on a PGLite brain.
 *
 * One synthetic fixture brain (test/fixtures/rust-cli-parity-brain, 20 pages with frontmatter, tags, aliases, links
 * and timeline lines) is written into two brains through the real CLI entry (`src/cli.ts`, one child process per
 * command): `import --no-embed`, then `extract all --source db`. One brain's config says `engine: 'pglite'`, the
 * other's says `engine: 'rust'` (the opt-in engine value). Then every read command below runs with `--json` on both
 * brains, and the parsed JSON is compared after what no two runs can share is normalised: time stamps, UUIDs, row ids
 * timings, clock-derived values and each brain's temp path (the rules of test/rust-engine-differential.test.ts),
 * and fractions agree to one part in a million (clock-decayed scores move between runs milliseconds apart). A score
 * that decays with a page's age is compared without its clock term (withAgeDecayCompared).
 *
 * When a setup write is refused on the Rust brain (the typed refusal), the Rust brain does not hold the fixture, and
 * comparing its reads with the full PGLite brain would only report the missing pages. A third brain, the mirror,
 * is then the reference: a PGLite brain that ran only the setup writes the Rust brain completed. Both hold the same
 * data, so each read must still answer the same way (exit code and JSON); the table marks those rows `vs mirror`.
 * The full PGLite brain still runs every command, so the fixture and the command list stay checked.
 *
 * Doctor is the one exception: its report cannot equal PGLite's while members refuse, so its own test (`runs`) checks
 * that it finishes with no failed check and no filesystem-only fallback, and pins each difference from PGLite.
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
 * Write commands in RECORDED_WRITES run last. Each one must write on the PGLite brain. On the Rust brain it either
 * refuses with the typed refusal that names the next engine member its write path needs, or is accepted and stays
 * queued (write_pending) behind the member the background writer needs.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 * 1. Protects: the agent-facing contract of the read commands, end to end (flag parsing, operation dispatch, engine
 *    members, JSON rendering), on a Rust brain.
 * 2. Fails when: a Rust member answers a command differently from PGLite (or from the mirror when a setup write was
 *    refused), or a refusal is untyped or a near answer; or doctor on the Rust brain fails a check, falls back to the
 *    filesystem-only checks, or gains a check name, an untyped warning or an ok-while-refused check not listed.
 * 3. Existing coverage: the engine parity suite (test/engine-parity/) compares single members in process; nothing
 *    compares whole CLI commands, where several members and the operation layer combine.
 * 4. Seams: none. It runs the real CLI and needs the addon `bun run rust:build` writes; it skips without it
 *    (GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes a missing addon an error).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';

const ROOT = resolve(import.meta.dir, '..');
const CLI = join(ROOT, 'src', 'cli.ts');
const EFFECT_PASS = join(ROOT, 'test', 'helpers', 'effect-pass-process.ts');
const FIXTURE = join(ROOT, 'test', 'fixtures', 'rust-cli-parity-brain');
const TARGET = detectAddonTarget();
const ADDON = TARGET ? join(ROOT, 'rust', 'target', 'addon', `gbrain_engine.${TARGET}.node`) : '';
const HAVE_ADDON = !!TARGET && existsSync(ADDON);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${ADDON || 'no addon target'} does not exist; run bun run rust:build`);
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

async function run(argv: string[], brain: Brain): Promise<Run> {
  const proc = Bun.spawn(argv, { cwd: root, env: childEnv(brain), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exitCode };
}

async function cli(brain: Brain, args: string[]): Promise<Run> {
  return run(['bun', 'run', CLI, ...args], brain);
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

/**
 * Scores that decay with a page's age. The two brains are written by two processes that finish seconds apart, and each
 * read runs in its own process, so the same page has two write times and two read times, and salience's flat recency
 * term (`1 / (1 + age in days)`, the default `buildRecencyComponentSql` branch) differs by those gaps alone. Run on one
 * fixed clock, both engines print the same score. Here the recency term is taken off each row with that row's own write
 * time and one shared read time, and the clock-free rest (`emotional_weight * 5 + ln(1 + take_count)`) must agree to
 * 1e-4, about eight seconds of read-time gap. When it does, the Rust row takes the reference row's score; when it does
 * not, the row is left as printed and fails the comparison. Rows pair by position and must name the same page.
 */
const AGE_DECAYED = new Set(['salience']);
function withAgeDecayCompared(args: string[], ref: unknown, rust: unknown): unknown {
  if (!AGE_DECAYED.has(args[0]) || !Array.isArray(ref) || !Array.isArray(rust)) return rust;
  const now = Date.now();
  const clockFree = (row: Record<string, unknown>) => (row.score as number) - 1 / (1 + (now - Date.parse(String(row.updated_at))) / 86_400_000);
  return rust.map((row, i) => {
    const want = ref[i] as Record<string, unknown> | undefined;
    const r = row as Record<string, unknown>;
    if (!want || r.slug !== want.slug || r.source_id !== want.source_id) return row;
    if (typeof r.score !== 'number' || typeof want.score !== 'number') return row;
    if (typeof r.updated_at !== 'string' || typeof want.updated_at !== 'string') return row;
    return Math.abs(clockFree(r) - clockFree(want)) <= 1e-4 ? { ...r, score: want.score } : row;
  });
}

/**
 * The one intended difference in the embeddings readiness fix: a Rust brain names `gbrain embeddings enable`, which
 * keeps the Rust engine, where a PGLite brain names `gbrain init --force ... --path <db>` (it would rebuild a Rust
 * store as PGLite; test/rust-engine-readiness-fix.test.ts pins both). Where the Rust answer holds exactly that Rust
 * form and the reference holds the PGLite form with the same model and width, the Rust answer takes the reference
 * value; the datastore label ("the Rust brain at") is mapped the same way. Anything else still differs.
 */
function withEnableFixCompared(ref: unknown, rust: unknown): unknown {
  if (typeof rust === 'string' && typeof ref === 'string') {
    return rust.replace(/for the Rust brain at /g, 'for the PGLite brain at ') === ref ? ref : rust;
  }
  if (Array.isArray(rust) && Array.isArray(ref)) {
    const rustForm = rust.length === 7 && rust.slice(0, 3).join(' ') === 'gbrain embeddings enable';
    const refForm = ref.length === 9 && ref.slice(0, 3).join(' ') === 'gbrain init --force' && ref[7] === '--path';
    if (rustForm && refForm && JSON.stringify(rust.slice(3)) === JSON.stringify(ref.slice(3, 7))) return ref;
    return rust.map((item, i) => withEnableFixCompared(ref[i], item));
  }
  if (rust && ref && typeof rust === 'object' && typeof ref === 'object') {
    const r = ref as Record<string, unknown>;
    return Object.fromEntries(Object.entries(rust as Record<string, unknown>).map(([k, v]) => [k, withEnableFixCompared(r[k], v)]));
  }
  return rust;
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

/**
 * Write commands whose Rust outcome is recorded: the PGLite brain must write, and the Rust brain must refuse with the
 * typed refusal that names the member given here, the next engine member the write path needs. When a later change
 * serves that member, this case fails and names the new next member, so the record stays current.
 */
/** A write stops on Rust with a typed refusal that names `member`, or is accepted and stays queued behind `member`. */
const RECORDED_WRITES: Array<{ args: string[]; rust: 'equal' } | { args: string[]; rust: 'refused' | 'queued'; member: string }> = [
  { args: ['put', 'notes/parity-put', '--content', '---\ntype: note\ntitle: Parity put\n---\nBody text.\n', '--json'], rust: 'equal' },
];
// `put` records, claims, publishes and completes its request on the Rust brain as on PGLite: the store keeps the
// publication's effects (insertPublicationEffects) and the receipt says committed. Its `write-request` receipt is then
// read on both brains: the same, but for the effects, which the Rust brain stores and does not run yet.

type State = 'equal' | 'refused' | 'queued' | 'diverged' | 'no-engine' | 'runs';
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
  lines.push(`[rust cli parity] ${count('equal')} equal, ${count('refused')} refused, ${count('queued')} queued, ${count('diverged')} diverged, ${count('no-engine')} without a Rust engine`);
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
    // The mirror is the reference only while a Rust setup write is refused; once every write runs, the full brain is.
    expect(useMirror).toBe(setupRows.some((r) => r.state === 'refused'));
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
      const asJson = (run: Run, brain: Brain, json = parseJson(run.stdout)) =>
        normalize(json === undefined ? `${run.stdout}\n${run.stderr}` : json, pathsOf(brain));
      const refJson = parseJson(ref.stdout);
      const rustJson = parseJson(rust.stdout);
      const want = { exitCode: ref.exitCode, json: asJson(ref, refBrain, refJson) };
      const rustSide = asJson(rust, brains.rust, rustJson === undefined ? undefined : withAgeDecayCompared(args, refJson, rustJson));
      const got = { exitCode: rust.exitCode, json: withEnableFixCompared(want.json, rustSide) };
      const equal = got.exitCode === want.exitCode && same(got.json, want.json);
      const notes = [useMirror ? 'vs mirror' : '', equal && ref.exitCode !== 0 ? `both exit ${ref.exitCode}` : '', equal ? '' : `exit ${rust.exitCode}`].filter(Boolean);
      table.push({ command: label(args), state: equal ? 'equal' : 'diverged', note: notes.join(', ') });
      // A wrong answer is never acceptable: the Rust brain refuses with a typed refusal or answers exactly.
      if (!equal) expect(got).toEqual(want);
    }, 240_000);
  }

  for (const write of RECORDED_WRITES) {
    const { args, rust: outcome } = write;
    const next = 'member' in write ? write.member : '';
    const title = outcome === 'equal' ? 'writes on PGLite and on Rust with the same answer'
      : `writes on PGLite and ${outcome === 'refused' ? 'refuses on Rust at' : 'stays queued on Rust behind'} ${next}`;
    test(`${label(args)} ${title}`, async () => {
      const [pg, rust] = await Promise.all([cli(brains.pglite, args), rustArm === 'on' ? cli(brains.rust, args) : Promise.resolve(null)]);
      expect({ exitCode: pg.exitCode, json: parseJson(pg.stdout) !== undefined }).toEqual({ exitCode: 0, json: true });
      if (!rust || engineMissing(rust)) {
        table.push({ command: label(args), state: 'no-engine', note: '' });
        return;
      }
      const member = refusedMember(rust);
      if (outcome === 'equal') {
        // The write completed on Rust, so the mirror (PGLite with the writes Rust completed) gets it too.
        const mirror = await cli(brains.mirror, args);
        expect(mirror.exitCode).toBe(0);
        const want = { exitCode: pg.exitCode, member: null, json: normalize(parseJson(pg.stdout), pathsOf(brains.pglite)) };
        const got = { exitCode: rust.exitCode, member, json: normalize(parseJson(rust.stdout) ?? `${rust.stdout}\n${rust.stderr}`, pathsOf(brains.rust)) };
        const equal = got.exitCode === want.exitCode && got.member === null && same(got.json, want.json);
        table.push({ command: label(args), state: equal ? 'equal' : 'diverged', note: equal ? 'written' : member ?? `exit ${rust.exitCode}` });
        if (!equal) expect(got).toEqual(want);
        // The write's receipt reads the same on both brains, its effects included: each brain ran its effect pass and
        // settled each effect the same way (rust/docs/store/persistence.md, "Effect worker"). The put's own process stops
        // its effect drain once it has replied (GBRA-156), so each brain runs one effect pass first, in its own
        // environment; otherwise the receipt reads whichever side of that race the put landed on.
        const passes = await Promise.all([brains.pglite, brains.rust].map((brain) => run(['bun', 'run', EFFECT_PASS], brain)));
        expect(passes.map((pass) => pass.exitCode)).toEqual([0, 0]);
        const requestOf = (run: Run) => String((parseJson(run.stdout) as { request_id?: unknown } | undefined)?.request_id ?? '');
        const [pgReceipt, rustReceipt] = await Promise.all([cli(brains.pglite, ['write-request', requestOf(pg), '--json']),
          cli(brains.rust, ['write-request', requestOf(rust), '--json'])]);
        type Receipt = { effects?: Array<Record<string, unknown>> } & Record<string, unknown>;
        const pgBody = parseJson(pgReceipt.stdout) as Receipt | undefined;
        const rustBody = parseJson(rustReceipt.stdout) as Receipt | undefined;
        expect({ exitCode: rustReceipt.exitCode, receipt: normalize(rustBody, []), member: refusedMember(rustReceipt) })
          .toEqual({ exitCode: pgReceipt.exitCode, receipt: normalize(pgBody, []), member: null });
        expect(pgBody?.effects?.some((e) => e.kind === 'embedding' && e.state === 'skipped')).toBe(true);
        return;
      }
      if (outcome === 'queued') {
        // Accepted, never applied: the reply is the typed pending receipt, not a refusal or a success.
        const body = parseJson(rust.stdout) as { code?: string; state?: string } | undefined;
        const queued = rust.exitCode === 10 && body?.code === 'write_pending' && body?.state === 'queued';
        table.push({ command: label(args), state: queued ? 'queued' : 'diverged', note: queued ? `behind ${next}` : `exit ${rust.exitCode}` });
        expect({ exitCode: rust.exitCode, code: body?.code, state: body?.state, member }).toEqual({ exitCode: 10, code: 'write_pending', state: 'queued', member: null });
        // The receipt's state is the stored row read after the writer returned its claim (finishUnpublishedFailure).
        return;
      }
      table.push({ command: label(args), state: member ? 'refused' : 'diverged', note: member ?? `exit ${rust.exitCode}` });
      // Nothing ran on Rust: the refusal is typed, names the next member, and reports that nothing was written.
      expect({ member, written: /written=nothing/.test(rust.stdout) }).toEqual({ member: next, written: true });
    }, 240_000);
  }

  // Doctor reads every health table, so its report is not expected to equal PGLite's while members still refuse.
  // The contract here is that doctor runs on a Rust brain: it finishes, fails nothing, never falls back to the
  // filesystem-only checks, and says why for each check it could not run. The lists below pin every difference
  // from PGLite that is not a typed refusal, so a new one fails this test until it is reviewed and listed.
  // The reference is the mirror: PGLite holding exactly the writes the Rust brain completed (a recorded write above
  // adds a page to the PGLite brain only), so a warning that counts pages or chunks compares on the same data.
  test('doctor --json on a Rust brain runs every check and names the cause of each warning', async () => {
    const [pg, rust] = await Promise.all([cli(brains.mirror, ['doctor', '--json']), rustArm === 'on' ? cli(brains.rust, ['doctor', '--json']) : Promise.resolve(null)]);
    type Check = { name: string; status: string; message: string };
    const pgReport = parseJson(pg.stdout) as { checks?: Check[] } | undefined;
    expect({ exitCode: pg.exitCode, checks: Array.isArray(pgReport?.checks) }).toEqual({ exitCode: 0, checks: true });
    if (!rust || engineMissing(rust)) { table.push({ command: 'doctor --json', state: 'no-engine', note: '' }); return; }
    const report = parseJson(rust.stdout) as { engine?: string; checks?: Check[] } | undefined;
    expect({ exitCode: rust.exitCode, engine: report?.engine, checks: Array.isArray(report?.checks) }).toEqual({ exitCode: 0, engine: 'rust', checks: true });
    expect(`${rust.stdout}\n${rust.stderr}`).not.toMatch(/DB-backed doctor run failed|filesystem-only/);
    const checks = report!.checks!;
    const pgNames = new Set(pgReport!.checks!.map((c) => c.name));
    const pgByName = new Map(pgReport!.checks!.map((c) => [c.name, c]));
    const likePglite = (c: Check) => pgByName.get(c.name)?.status === c.status && pgByName.get(c.name)?.message === c.message;
    const names = new Set(checks.map((c) => c.name));
    const TYPED = /does not support \w+ yet \(it needs the \w+ capability\)/;
    const sorted = (xs: Iterable<string>) => [...xs].sort();
    expect({
      fail: checks.filter((c) => c.status === 'fail').map((c) => c.name),
      // Engine-specific checks: PGLite-only (scale, local path, file scans) and the managed-sync checks PGLite skips.
      onlyPglite: sorted([...pgNames].filter((n) => !names.has(n))),
      onlyRust: sorted([...names].filter((n) => !pgNames.has(n))),
      // Warnings that do not quote the typed refusal and differ from PGLite: each one is a refused read the check
      // reports in its own words.
      untypedWarnings: sorted(checks.filter((c) => c.status !== 'ok' && !TYPED.test(c.message) && !likePglite(c)).map((c) => c.name)),
      // Warnings with the same status and message as PGLite on the same data: the brain itself warrants them.
      warnLikePglite: sorted(checks.filter((c) => c.status !== 'ok' && !TYPED.test(c.message) && likePglite(c)).map((c) => c.name)),
      // Checks that report ok although a refused read stopped them: none. A refused check warns, health unknown.
      okWhileRefused: sorted(checks.filter((c) => c.status === 'ok' && TYPED.test(c.message)).map((c) => c.name)),
    }).toEqual({
      fail: [],
      onlyPglite: ['default_source_local_path', 'frontmatter_repairable', 'image_assets', 'pglite_scale'],
      // multi_source_drift is gone from this list: it reads listSourceRecords, which Rust serves, so on this
      // one-source brain it skips exactly as PGLite does instead of warning with the executeRaw refusal.
      // canonical_content_writes is gone from this list: the owned-content read is a typed member on Rust, and a Rust
      // brain has no writer-owned source yet, so the check skips as it does on this PGLite brain.
      // shared_skills_sources is gone from this list: the source view reads readSourceState, which Rust serves, so
      // with no opted-out or parked source the check returns nothing, as it does on PGLite.
      onlyRust: ['checkout_lagging', 'commits_outside_source_root', 'dirty_age', 'git_convergence',
        'quarantined_changes', 'sync_failures', 'tracked_ownership_marker',
        'transcript_secret_exposure'],
      // entity_link_coverage, graph_coverage, orphan_ratio and timeline_coverage are gone from this list: the entity
      // types resolve on a Rust brain (overrideSourcesFromKeys), so those checks pass as they do on PGLite.
      // trust_scan counts the pages and facts on Rust, then warns with the refusal of the takes count, which names
      // the table in the member's parenthesis ("the takes table, whose rows the store does not stamp").
      // fact_take_vectors is gone from this list: a new Rust brain records its embedding model and width as PGLite
      // does, so the check reads the same model and passes with PGLite's message.
      // child_table_orphans is gone from this list: the page child counts are typed members on Rust
      // (engine-sql/repair-page-reads.ts), so the check passes with PGLite's message.
      // backup_coverage is gone from this list: a Rust brain counts its live pages and reads its maturity
      // (countBrainLivePages, readBrainMaturity), so the check answers as it does on PGLite.
      // entity_duplicates warns with the named refusal of listEntityKeyRows, which names what the store's key rows lack
      // in the member's parenthesis (the page id, generation, creation time and identity group, and the members and
      // tokens filters); the full key-row shape is lane 5's.
      untypedWarnings: ['entity_duplicates', 'extract_atoms_backlog', 'raw_provenance', 'retrieval_reflex_health', 'sync_failures',
        'text_projection_readiness', 'trust_scan'],
      // The imported fixture has no embeddings, so both engines score it below 100 and count its chunks stale; the pack
      // reads are served, so the successor notice is the same. embeddings is not here: Rust cannot read the backlog
      // age, so it warns with that typed refusal where PGLite reads the age and passes.
      warnLikePglite: ['brain_score', 'embed_staleness', 'embedding_provider', 'pack_upgrade_available'],
      okWhileRefused: [],
    });
    const count = (s: string) => checks.filter((c) => c.status === s).length;
    table.push({ command: 'doctor --json', state: 'runs', note: ` ${checks.length} checks, ${count('ok')} ok, ${count('warn')} warn, 0 fail; PGLite ${pgReport!.checks!.length}` });
  }, 600_000);
});
