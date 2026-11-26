/**
 * The token and member commands print the same bytes on every engine.
 *
 * One script of `gbrain access member ...` and `gbrain auth ...` commands runs through the real CLI entry
 * (`src/cli.ts`, one child process per command) on a fresh brain per engine: PGLite, Postgres (when DATABASE_URL is
 * set; a fresh database per run) and Rust (when the addon is built). The script adds, edits, disables, enables and
 * removes members, mints and lists tokens, registers a client bound to a member, and edits a token's member binding
 * (`auth rescope --member / --reads-unscoped / --may-act-for / --attest-actor`) and its grants (`--sources`,
 * `--operations`, `--takes-holders`, `--private-pages`, `--private-facts`, `--reset-default`, `--migrate-legacy`), with
 * the refusals in between. Each
 * command's exit code, stdout and stderr must equal PGLite's byte for byte once what no two runs share is masked:
 * UUIDs, minted secrets, client ids and wall-clock instants. The first command only opens the brain (a fresh
 * PGLite brain prints its schema setup, which no other engine does) and is not compared.
 *
 * A second script (ENFORCED_SCRIPT) puts pages on a brain of two members: a put with no source named, then puts
 * under GBRAIN_ENFORCED_MEMBER by a member the page lists and by one it does not, and the reads that follow.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 * 1. Protects: the user-visible output of the token and member commands, end to end (flag parsing, the access
 *    checks, engine members, rendering), on each engine; and a put on a brain of several members, plain and under
 *    GBRAIN_ENFORCED_MEMBER (its placement notice, a refusal that changes nothing, a rewrite that keeps the readers).
 * 2. Fails when: an engine answers one of these commands with other text, another exit code or an engine error, for
 *    example a Rust brain that cannot read the member a token is bound to, that cannot lock the token rescope edits,
 *    or that cannot write the grant a rescope sets; or a Rust put prints no placement block or refuses an enforced
 *    member's put with engine_capability_missing.
 * 3. Existing coverage: the engine parity suite (test/engine-parity/) compares single members in process;
 *    test/rust-cli-parity.serial.test.ts compares the read commands' JSON, not these commands' text.
 * 4. Seams: none. It runs the real CLI. The Rust brain needs the addon `bun run rust:build` writes and is skipped
 *    without it (GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes a missing addon an error).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const ROOT = resolve(import.meta.dir, '..');
const CLI = join(ROOT, 'src', 'cli.ts');
const TARGET = detectAddonTarget();
const ADDON = TARGET ? join(ROOT, 'rust', 'target', 'addon', `gbrain_engine.${TARGET}.node`) : '';
const HAVE_ADDON = !!TARGET && existsSync(ADDON);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${ADDON || 'no addon target'} does not exist; run bun run rust:build`);
}

/** The script. Index 0 opens the brain and is not compared. */
const SCRIPT: string[][] = [
  ['access', 'member', 'list'],
  ['access', 'member', 'add', 'alice-example', '--name', 'Alice'],
  ['auth', 'create', 'laptop', '--member', 'alice-example'],
  ['auth', 'create', 'tablet', '--scopes', 'read'],
  ['auth', 'create', 'service', '--scopes', 'read'],
  ['access', 'member', 'add', 'bob-example'],
  ['access', 'member', 'add', 'carol-example', '--bind-token', 'tablet'],
  ['access', 'member', 'add', 'dave-example', '--bind-token', 'nothing'],
  ['auth', 'list'],
  ['auth', 'list', '--json'],
  ['auth', 'register-client', 'phone-app', '--grant-types', 'client_credentials', '--scopes', 'read', '--member', 'alice-example'],
  ['auth', 'clients'],
  ['access', 'member', 'list', '--json'],
  ['access', 'member', 'set', 'alice-example', '--email', 'alice@example.com'],
  ['access', 'member', 'kind', 'alice-example', 'audience'],
  ['access', 'member', 'list'],
  ['auth', 'rescope', '--token', 'laptop', '--member', 'bob-example'],
  ['auth', 'rescope', '--token', 'laptop', '--reads-unscoped', '--yes'],
  ['auth', 'rescope', '--token', 'laptop', '--may-act-for', 'alice-example'],
  ['auth', 'rescope', '--token', 'laptop', '--attest-actor', 'qm', '--attest-ops', 'get_page'],
  ['auth', 'rescope', '--token', 'service', '--attest-actor', 'qm', '--attest-ops', 'get_page'],
  ['auth', 'rescope', '--token', 'nothing', '--member', 'bob-example'],
  ['auth', 'rescope', '--token', 'laptop', '--member', 'nobody-example'],
  ['auth', 'rescope', '--token', 'laptop', '--json'],
  ['auth', 'list', '--json'],
  ['access', 'member', 'disable', 'bob-example'],
  ['access', 'member', 'enable', 'bob-example'],
  ['access', 'member', 'disable', 'bob-example', '--json'],
  ['access', 'member', 'rm', 'alice-example'],
  ['auth', 'revoke', 'tablet'],
  ['access', 'member', 'list', '--all', '--json'],
  ['auth', 'list'],
  ['auth', 'clients', '--json'],
  // The grant edits of one token (index 33 on): each axis, the private grants, a reset, the refusals, a preview and the
  // bulk migration, then the list that shows what they wrote.
  ['auth', 'rescope', '--token', 'service', '--sources', 'default'],
  ['auth', 'rescope', '--token', 'service', '--operations', 'get_page,search'],
  ['auth', 'rescope', '--token', 'service', '--takes-holders', 'world,brain'],
  ['auth', 'rescope', '--token', 'service', '--private-pages', 'granted-sources'],
  ['auth', 'rescope', '--token', 'service', '--private-facts', 'granted-sources'],
  ['auth', 'rescope', '--token', 'service', '--json'],
  ['auth', 'list', '--json'],
  ['auth', 'rescope', '--token', 'service', '--reset-default', 'sources,takes-holders,operations', '--json'],
  ['auth', 'rescope', '--token', 'service', '--sources', 'nosuch'],
  ['auth', 'rescope', '--token', 'service', '--operations', 'not_an_op'],
  ['auth', 'rescope', '--token', 'service', '--if-version', '1', '--sources', 'default'],
  ['auth', 'rescope', '--token', 'service', '--refresh-operations', '--json'],
  ['auth', 'rescope', '--token', 'service', '--private-pages', 'none', '--dry-run'],
  ['auth', 'rescope', '--token', 'service', '--private-pages', 'none', '--private-facts', 'none', '--scopes', 'read,write'],
  ['auth', 'rescope', '--migrate-legacy', '--json'],
  ['auth', 'list'],
];

/**
 * The second script: a brain of two members, a page that lists one of them, and puts of that page. `rev` names the
 * revision the earlier put with that label printed (it differs per engine); `member` runs the command under
 * GBRAIN_ENFORCED_MEMBER; `exit` is the exit code PGLite must give (0 unless set). Index 0 opens the brain and is not compared.
 */
interface Step { label?: string; args: string[]; member?: string; stdin?: string; rev?: string; exit?: number }
const PLAN = (line: string) => `---\ntitle: Launch plan\nreadable_by:\n  - tess-example\n---\n# Launch plan\n\n${line}\n`;
const ENFORCED_SCRIPT: Step[] = [
  { args: ['access', 'member', 'list'] },
  { args: ['access', 'member', 'add', 'bob-example', '--name', 'Bob Example', '--json'] },
  { args: ['access', 'member', 'add', 'tess-example', '--name', 'Tess Example', '--json'] },
  // A put that names no source, on a brain of several members: the result carries the placement notice.
  { label: 'draft', args: ['put', 'notes/launch-plan', '--content', PLAN('Tess Example drafts the launch plan.'), '--json'] },
];

type Engine = 'pglite' | 'postgres' | 'rust';
interface Brain { engine: Engine; home: string }
interface Run { exitCode: number; stdout: string; stderr: string }

let root = '';
const brains: Brain[] = [];
let closePg: (() => Promise<void>) | undefined;
const runs = new Map<Engine, Run[]>();

function childEnv(brain: Brain, member?: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) out[key] = value;
  for (const key of Object.keys(out)) {
    if (/^(DATABASE_URL|GBRAIN_DATABASE_URL|GBRAIN_BRAIN_ID|GBRAIN_SOURCE|GBRAIN_RUST_ENGINE_ADDON)$/.test(key)) delete out[key];
    if (/(_API_KEY|_API_TOKEN)(__|$)/.test(key)) delete out[key]; // keyless: no provider is ever called
    if (key === 'GBRAIN_ENFORCED_MEMBER') delete out[key];
  }
  return {
    ...out,
    ...(member ? { GBRAIN_ENFORCED_MEMBER: member } : {}),
    HOME: brain.home,
    GBRAIN_HOME: brain.home,
    GBRAIN_SELF_UPGRADE_MODE: 'off',
    GBRAIN_SKIP_STARTUP_HOOKS: '1',
    GBRAIN_SWEEP: '0',
    TZ: 'UTC',
    ...(brain.engine === 'rust' ? { GBRAIN_RUST_ENGINE_ADDON: ADDON } : {}),
  };
}

async function cli(brain: Brain, args: string[], opts: { member?: string; stdin?: string } = {}): Promise<Run> {
  const proc = Bun.spawn(['bun', 'run', CLI, ...args], { cwd: root, env: childEnv(brain, opts.member), stdin: opts.stdin === undefined ? 'ignore' : new Blob([opts.stdin]), stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { exitCode, stdout, stderr };
}

function makeBrain(engine: Engine, config: Record<string, unknown>, slot = ''): Brain {
  const home = join(root, slot + engine, 'home');
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine, ...config }));
  return { engine, home };
}

/** Masks what no two runs share: UUIDs, minted token and client secrets, client ids, wall-clock instants. */
function masked(text: string): string {
  return text
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/gbrain_(cl|cs)_[0-9a-f]{64}/g, 'gbrain_$1_<hex>')
    .replace(/gbrain_[0-9a-f]{64}/g, '<token>')
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g, '<instant>');
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'gb-token-member-cli-'));
  brains.push(makeBrain('pglite', { database_path: join(root, 'pglite', 'db') }));
  if (process.env.DATABASE_URL) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    await pg.engine.disconnect();
    closePg = pg.close;
    brains.push(makeBrain('postgres', { database_url: pg.databaseUrl }));
  }
  if (HAVE_ADDON) brains.push(makeBrain('rust', { database_path: join(root, 'rust', 'db') }));
  // Each brain runs the script in order; the brains run side by side.
  await Promise.all(brains.map(async (brain) => {
    const out: Run[] = [];
    for (const args of SCRIPT) out.push(await cli(brain, args));
    runs.set(brain.engine, out);
  }));
}, 600_000);

/** The second script's brains and what each command printed. */
const enforcedBrains: Brain[] = [];
const enforcedRuns = new Map<Engine, Run[]>();
let closeEnforcedPg: (() => Promise<void>) | undefined;

beforeAll(async () => {
  enforcedBrains.push(makeBrain('pglite', { database_path: join(root, 'e-pglite', 'db') }, 'e-'));
  if (process.env.DATABASE_URL) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    await pg.engine.disconnect();
    closeEnforcedPg = pg.close;
    enforcedBrains.push(makeBrain('postgres', { database_url: pg.databaseUrl }, 'e-'));
  }
  if (HAVE_ADDON) enforcedBrains.push(makeBrain('rust', { database_path: join(root, 'e-rust', 'db') }, 'e-'));
  await Promise.all(enforcedBrains.map(async (brain) => {
    const out: Run[] = [];
    const revisions = new Map<string, string>();
    for (const step of ENFORCED_SCRIPT) {
      const args = step.args.map((a) => a === '{rev}' ? revisions.get(step.rev ?? '') ?? '' : a);
      const run = await cli(brain, args, { member: step.member, stdin: step.stdin });
      out.push(run);
      if (step.label) { try { revisions.set(step.label, String(JSON.parse(run.stdout).revision ?? '')); } catch { /* not JSON: the compared output shows it */ } }
    }
    enforcedRuns.set(brain.engine, out);
  }));
}, 600_000);

afterAll(async () => {
  if (root) rmSync(root, { recursive: true, force: true });
  await closePg?.();
  await closeEnforcedPg?.();
}, 60_000);

describe('token and member commands on every engine', () => {
  test('the script runs as written on PGLite: each command succeeds or refuses where it should', () => {
    // dave-example names a token that does not exist; a token bound to a member cannot attest an actor; rescope of
    // an unknown token and to an unknown member refuse.
    const refused = new Map([[7, 2], [19, 2], [21, 1], [22, 1], [41, 1], [42, 1], [43, 1]]);
    const codes = runs.get('pglite')!.map((r, i) => `${r.exitCode} ${SCRIPT[i].join(' ')}`);
    expect(codes).toEqual(SCRIPT.map((args, i) => `${refused.get(i) ?? 0} ${args.join(' ')}`));
  });

  for (const engine of ['postgres', 'rust'] as const) {
    test(`${engine} prints what PGLite prints for every command`, () => {
      const theirs = runs.get(engine);
      if (!theirs) return; // that engine is not configured on this run
      const ours = runs.get('pglite')!;
      const view = (r: Run[]) => r.slice(1).map((run, i) => ({
        command: SCRIPT[i + 1].join(' '), exitCode: run.exitCode, stdout: masked(run.stdout), stderr: masked(run.stderr),
      }));
      expect(view(theirs)).toEqual(view(ours));
    });
  }
});

describe('a put on a brain of several members, plain and under GBRAIN_ENFORCED_MEMBER, on every engine', () => {
  test('the script runs as written on PGLite', () => {
    const codes = enforcedRuns.get('pglite')!.map((r, i) => `${r.exitCode} ${ENFORCED_SCRIPT[i].label ?? ENFORCED_SCRIPT[i].args[0]}`);
    expect(codes).toEqual(ENFORCED_SCRIPT.map((s) => `${s.exit ?? 0} ${s.label ?? s.args[0]}`));
  });

  for (const engine of ['postgres', 'rust'] as const) {
    test(`${engine} prints what PGLite prints for every put and read`, () => {
      const theirs = enforcedRuns.get(engine);
      if (!theirs) return; // that engine is not configured on this run
      const ours = enforcedRuns.get('pglite')!;
      const view = (r: Run[]) => r.slice(1).map((run, i) => ({
        command: ENFORCED_SCRIPT[i + 1].label ?? ENFORCED_SCRIPT[i + 1].args.join(' '), exitCode: run.exitCode, stdout: masked(run.stdout), stderr: masked(run.stderr),
      }));
      expect(view(theirs)).toEqual(view(ours));
    });
  }
});
