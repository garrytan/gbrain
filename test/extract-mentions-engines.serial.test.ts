/**
 * `gbrain extract` and the mention reads on an unmanaged brain whose source has a local path, run as CLI processes on
 * PGLite, Postgres (with DATABASE_URL) and Rust (with the addon), compared byte for byte.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: after `sources add --path` and `import`, every engine gives the same exit code and the same --json bytes
 *    (temp paths and wall-clock instants aside) for `extract all` (fs walk), `extract all --source db`, the stale sweep
 *    with the mention pass (`extract --stale --catch-up`, then `--dry-run`), the by-mention pass and its `--rebuild`,
 *    `extract mentions --explain` (a name, a name on a page, a title subject), `stats`, and the pass again after an
 *    edit, after linking is turned off and after it is turned back on. One note is past the inline limit, so it is
 *    stored segmented and the mention pass scans it run by run; `extract all` (fs walk) extracts it too, reading its
 *    dated link evidence block by block (it read the body as one string and exited 1 on every engine).
 *  - Regression: on a Rust brain `extract all` stopped at its watermark snapshot read, the stale sweep at the mention
 *    pass's source list, and the by-mention pass and explain at the gazetteer read, each with engine_capability_missing
 *    (raw SQL), so the owner's unmanaged brain could not run its extract cron on Rust.
 *  - Why existing coverage misses it: test/rust-cli-parity.serial.test.ts runs only `extract all --source db` on a
 *    Rust brain and no mention pass; the mention tests run in process on the SQL engines.
 *  - Seam: none. Real CLI processes (`bun run src/cli.ts`) with a temp HOME per brain, keyless (no provider key).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const ROOT = join(import.meta.dir, '..');
const CLI = join(ROOT, 'src', 'cli.ts');
const FIXTURE = join(ROOT, 'test', 'fixtures', 'rust-cli-parity-brain');
const TARGET = detectAddonTarget();
const ADDON = TARGET ? join(ROOT, 'rust', 'target', 'addon', `gbrain_engine.${TARGET}.node`) : '';
const HAVE_ADDON = !!TARGET && existsSync(ADDON);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${ADDON || 'no addon target'} does not exist; run bun run rust:build`);
}

type Arm = 'pglite' | 'postgres' | 'rust';
interface Brain { arm: Arm; home: string; repo: string; config: Record<string, unknown> }
interface Run { exitCode: number; stdout: string; stderr: string }

/** Pages the parity fixture lacks: a declared alias, a title subject and a note naming both. */
const EXTRA: Record<string, string> = {
  'people/quill-example.md': '---\ntype: person\ntitle: Quill Example\n---\n\n# Quill Example\n\nQuill Example, also known as "Featherstone", leads design at [[companies/acme-example]].\n',
  'companies/orbit-example.md': '---\ntype: company\ntitle: "CRM record: Orbit Labs"\n---\n\nOrbit Labs builds satellites with [[companies/widget-co]].\n',
  'notes/standup-note.md': '---\ntype: note\ntitle: Standup note\n---\n\nFeatherstone and Orbit Labs met with Alice Example and Widget Co about the ingest pipeline.\n',
};
/**
 * A note past the 1 MiB inline limit, so import stores it segmented: its entries name the declared alias, the title
 * subject and two people, so the mention pass scans it run by run and stores each run's mentions.
 */
function longNote(): string {
  const entries: string[] = [];
  let bytes = 0;
  for (let i = 1; bytes < 1_300_000; i++) {
    const entry = `## Entry ${i}\n\nFeatherstone and Orbit Labs reviewed the ingest pipeline with Widget Co. Alice Example took notes on keyword ranking and vector search, and the team agreed on the next steps for the brain index. Item ${i}.\n${i % 50 === 0 ? `\nOnly Charlie Example joined entry ${i}.\n` : ''}`;
    entries.push(entry);
    bytes += entry.length + 1;
  }
  return `---\ntype: note\ntitle: Long field log\n---\n\n# Long field log\n\n${entries.join('\n')}`;
}

const EDITED_NOTE = '---\ntype: note\ntitle: Standup note\n---\n\nOrbit Labs met with Bob Example about the ingest pipeline.\n';

let root = '';
const closers: Array<() => Promise<void>> = [];

function env(brain: Brain): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/^(DATABASE_URL|GBRAIN_DATABASE_URL|GBRAIN_BRAIN_ID|GBRAIN_SOURCE|GBRAIN_RUST_ENGINE_ADDON)$/.test(key)) continue;
    if (/(_API_KEY|_API_TOKEN)(__|$)/.test(key)) continue;
    out[key] = value;
  }
  return {
    ...out, HOME: brain.home, GBRAIN_HOME: brain.home, GBRAIN_SELF_UPGRADE_MODE: 'off', GBRAIN_SKIP_STARTUP_HOOKS: '1',
    GBRAIN_SWEEP: '0', TZ: 'UTC', ...(brain.arm === 'rust' ? { GBRAIN_RUST_ENGINE_ADDON: ADDON } : {}),
  };
}

async function cli(brain: Brain, args: string[]): Promise<Run> {
  const proc = Bun.spawn(['bun', 'run', CLI, ...args], { cwd: root, env: env(brain), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { exitCode, stdout, stderr };
}

/** The output with this brain's temp paths, every wall-clock instant and every timing replaced. */
function normalize(brain: Brain, text: string): string {
  return text.split(brain.repo).join('<repo>').split(brain.home).join('<home>')
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}(:?\d{2})?)?/g, '<instant>')
    .replace(/"(duration_s|duration_ms|elapsed_ms|latency_ms|took_ms)":\s*[\d.]+/g, '"$1":<clock>');
}

async function makeBrain(arm: Arm): Promise<Brain> {
  const dir = join(root, arm);
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  cpSync(FIXTURE, repo, { recursive: true });
  for (const [rel, text] of Object.entries(EXTRA)) {
    mkdirSync(join(repo, rel, '..'), { recursive: true });
    writeFileSync(join(repo, rel), text);
  }
  writeFileSync(join(repo, 'notes', 'long-field-log.md'), longNote());
  let config: Record<string, unknown> = { engine: arm, database_path: join(dir, 'db') };
  if (arm === 'postgres') {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    await pg.engine.disconnect();
    closers.push(pg.close);
    config = { engine: 'postgres', database_url: pg.databaseUrl };
  }
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify(config));
  return { arm, home, repo, config };
}

/** Each step: its label and the CLI arguments (a function: `repo` is the brain's own path). */
const STEPS: Array<[string, (b: Brain) => string[]]> = [
  ['sources add', b => ['sources', 'add', 'notes', '--path', b.repo, '--json']],
  ['import', b => ['import', b.repo, '--source', 'notes', '--no-embed', '--json']],
  ['extract all', () => ['extract', 'all', '--json']],
  ['extract all --source db', () => ['extract', 'all', '--source', 'db', '--json']],
  ['extract --stale --catch-up', () => ['extract', '--stale', '--catch-up', '--json']],
  ['extract --stale --dry-run', () => ['extract', '--stale', '--dry-run', '--json']],
  ['extract links --by-mention', () => ['extract', 'links', '--by-mention', '--source', 'db', '--json']],
  ['explain a declared name', () => ['extract', 'mentions', '--explain', 'Featherstone', '--source-id', 'notes', '--json']],
  ['explain a name on a page', () => ['extract', 'mentions', '--explain', 'Featherstone', '--page', 'notes/standup-note', '--source-id', 'notes', '--json']],
  ['explain a title subject', () => ['extract', 'mentions', '--explain', 'Orbit Labs', '--source-id', 'notes', '--json']],
  ['explain an unknown name', () => ['extract', 'mentions', '--explain', 'Nobody Here', '--source-id', 'notes', '--json']],
  ['by-mention --rebuild', () => ['extract', 'links', '--by-mention', '--rebuild', '--source', 'db', '--json']],
  ['stats', () => ['stats', '--json']],
];
/** After the note is edited and imported again: the pass, then linking off and on again. */
const AFTER_EDIT: Array<[string, (b: Brain) => string[]]> = [
  ['import the edit', b => ['import', b.repo, '--source', 'notes', '--no-embed', '--json']],
  ['stale after the edit', () => ['extract', '--stale', '--catch-up', '--json']],
  ['explain after the edit', () => ['extract', 'mentions', '--explain', 'Featherstone', '--page', 'notes/standup-note', '--source-id', 'notes', '--json']],
  ['linking off', () => ['config', 'set', 'mentions.auto_link', 'false']],
  ['stale with linking off', () => ['extract', '--stale', '--catch-up', '--json']],
  ['linking on', () => ['config', 'set', 'mentions.auto_link', 'true']],
  ['stale with linking on', () => ['extract', '--stale', '--catch-up', '--json']],
  ['dry run at the end', () => ['extract', '--stale', '--dry-run', '--json']],
  ['stats at the end', () => ['stats', '--json']],
];

type StepResult = { step: string; exitCode: number; stdout: string; failure: string[] };

/**
 * `stats --json` lists pages_by_type by count, and types with equal counts come back in no set order on PGLite and
 * Postgres (`ORDER BY count DESC`, no tie-break; lane 10's rust-engine/repair-rust-b9 adds the byte-order tie-break).
 * Rewrite that object with tied types in byte order so the arms compare on what is defined; every other byte stays as
 * printed.
 */
function settleTiedTypes(stdout: string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { return stdout; }
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (value === null || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (key !== 'pages_by_type' || item === null || typeof item !== 'object' || Array.isArray(item)) return [key, visit(item)];
      const entries = Object.entries(item as Record<string, number>);
      entries.sort(([ka, a], [kb, b]) => (b - a) || (ka < kb ? -1 : ka > kb ? 1 : 0));
      return [key, Object.fromEntries(entries)];
    }));
  };
  return JSON.stringify(visit(parsed), null, 2);
}

/** A step's result: its exit code, normalized stdout and, when it failed, the error lines it printed. */
function stepResult(brain: Brain, step: string, r: Run): StepResult {
  const failure = r.exitCode === 0 ? [] : r.stderr.split('\n').filter(l => /^(extract:|Error)/.test(l)).map(l => normalize(brain, l));
  const stdout = normalize(brain, r.stdout);
  return { step, exitCode: r.exitCode, stdout: step.startsWith('stats') ? settleTiedTypes(stdout) : stdout, failure };
}

async function runArm(arm: Arm): Promise<StepResult[]> {
  const brain = await makeBrain(arm);
  const out: StepResult[] = [];
  for (const [step, args] of STEPS) {
    const r = await cli(brain, args(brain));
    out.push(stepResult(brain, step, r));
  }
  writeFileSync(join(brain.repo, 'notes', 'standup-note.md'), EDITED_NOTE);
  for (const [step, args] of AFTER_EDIT) {
    const r = await cli(brain, args(brain));
    out.push(stepResult(brain, step, r));
  }
  return out;
}

const ARMS: Arm[] = ['pglite', ...(process.env.DATABASE_URL ? ['postgres' as const] : []), ...(HAVE_ADDON ? ['rust' as const] : [])];

describe('extract and the mention reads on an unmanaged brain with a local-path source, on every engine', () => {
  const results = new Map<Arm, StepResult[]>();
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'gbrain-extract-mentions-'));
    for (const arm of ARMS) results.set(arm, await runArm(arm));
  }, 1_200_000);
  afterAll(async () => {
    for (const close of closers) await close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test('PGLite runs every step and the passes do work', () => {
    const pglite = results.get('pglite')!;
    expect(pglite.filter(r => r.exitCode !== 0).map(r => r.step)).toEqual([]);
    const json = (step: string) => JSON.parse(pglite.find(r => r.step === step)!.stdout);
    expect(json('extract all').links_created).toBeGreaterThan(0);
    expect(json('extract all --source db').links_created).toBeGreaterThan(0);
    expect(json('extract --stale --catch-up').mention_links_created).toBeGreaterThan(0);
    expect(json('extract links --by-mention').links_created).toBeGreaterThan(0);
    expect(json('explain a name on a page')).toMatchObject({ reason: null, page: { slug: 'notes/standup-note', linked: true } });
    expect(json('stale with linking off')).toMatchObject({ mention_state: 'disabled' });
    expect(json('stale with linking off').mention_links_removed).toBeGreaterThan(0);
  });

  for (const arm of ['postgres', 'rust'] as const) {
    test(`${arm} gives the same exit code and --json bytes as PGLite at every step`, () => {
      const got = results.get(arm);
      if (!got) return; // the arm is not configured (no DATABASE_URL, no addon)
      expect(got).toEqual(results.get('pglite')!);
    });
  }
});
