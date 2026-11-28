/**
 * `gbrain doctor` checks the Rust store's keyword index and `gbrain doctor --fix` rebuilds it (doctor check
 * `rust_derived_indexes`; rust/docs/store/keyword.md, "Doctor"), on a real Rust brain, with and without a running owner.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 * 1. Protects: a keyword index whose chunk postings are gone is a doctor `fail` that `--fix` repairs, after which
 *    `gbrain search` finds what the records hold; a keyword index state that does not parse opens (search scans), is a
 *    doctor `warn`, and `--fix` repairs it. The rebuild writes no record outside the index, and doctor reports the
 *    same checks with the same statuses whether the CLI opens the brain itself or reaches it through `gbrain serve`.
 * 2. Fails when: doctor has no row for the index (the base before this check), the open refuses an unparseable
 *    state (`rust_store_unreadable`), the rebuild leaves postings missing or writes records, or the owner path
 *    answers differently.
 * 3. Existing coverage: the store's unit tests (keyword/index_health/tests.rs) drive the check and the rebuild on an
 *    in-memory store; no test runs the CLI's doctor on a damaged Rust brain, or through an owner.
 * 4. Seams: the damage comes from the development-only cargo example `derived_fault` (rust/crates/gbrain-store/
 *    examples/derived_fault.rs), which opens records.redb directly while no owner runs; nothing in the addon can
 *    reach it. The test builds it with cargo (GBRAIN_TEST_DERIVED_FAULT names a built one) and skips without cargo or
 *    the addon; GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes either missing an error.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';

const ROOT = resolve(import.meta.dir, '..');
const CLI = join(ROOT, 'src', 'cli.ts');
const TARGET = detectAddonTarget();
const ADDON = process.env.GBRAIN_TEST_RUST_ENGINE_ADDON
  || (TARGET ? join(ROOT, 'rust', 'target', 'addon', `gbrain_engine.${TARGET}.node`) : '');
const HAVE_ADDON = !!ADDON && existsSync(ADDON);
const HAVE_CARGO = !!process.env.GBRAIN_TEST_DERIVED_FAULT || Bun.which('cargo') !== null;
const REQUIRED = process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1';
if (REQUIRED && !HAVE_ADDON) throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${ADDON || 'no addon target'} does not exist; run bun run rust:build`);
if (REQUIRED && !HAVE_CARGO) throw new Error('GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but cargo is not on PATH to build the derived_fault example');

const CHECK = 'rust_derived_indexes';
const INDEX_TAG = 'R'.charCodeAt(0).toString(16); // keys::TRIGRAM, the keyword index's records

interface Run { exitCode: number; stdout: string; stderr: string }
interface Row { name: string; status: string; message: string; details?: { keyword?: { status: string }; rebuild?: { record_writes: number; index_puts: number } } }
type Digest = Record<string, { records: number; sha256: string }>;

let home = '';
let db = '';
let fault = '';
let owner: ReturnType<typeof Bun.spawn> | null = null;

function env(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) out[key] = value;
  for (const key of Object.keys(out)) {
    if (/^(DATABASE_URL|GBRAIN_DATABASE_URL|GBRAIN_BRAIN_ID|GBRAIN_SOURCE|GBRAIN_RUST_ENGINE_ADDON|GBRAIN_SKILLS_DIR|GBRAIN_RUST_KEYWORD_SCAN)$/.test(key)) delete out[key];
    if (/(_API_KEY|_API_TOKEN)(__|$)/.test(key)) delete out[key];
  }
  // An empty skills dir: the resolver check finds nothing to repair, so --fix never refuses for the install-path fallback.
  return { ...out, HOME: home, GBRAIN_HOME: home, GBRAIN_SKILLS_DIR: join(home, 'skills'), GBRAIN_SELF_UPGRADE_MODE: 'off',
    GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_SWEEP: '0', TZ: 'UTC', GBRAIN_RUST_ENGINE_ADDON: ADDON };
}

async function cli(args: string[]): Promise<Run> {
  const proc = Bun.spawn(['bun', 'run', CLI, ...args], { cwd: home, env: env(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exitCode };
}

function damage(mode: 'drop-chunk-postings' | 'garbage-state' | 'digest'): string {
  const run = Bun.spawnSync([fault, db, mode], { stdout: 'pipe', stderr: 'pipe' });
  if (run.exitCode !== 0) throw new Error(`derived_fault ${mode}: ${run.stderr.toString()}`);
  return run.stdout.toString();
}

const digest = (): Digest => JSON.parse(damage('digest')).tags;
const changedTags = (a: Digest, b: Digest) => [...new Set([...Object.keys(a), ...Object.keys(b)])]
  .filter(t => JSON.stringify(a[t]) !== JSON.stringify(b[t])).sort();

async function doctor(args: string[]): Promise<{ exitCode: number; statuses: Record<string, string>; row: Row | undefined }> {
  const run = await cli(['doctor', ...args, '--json']);
  let doc: { checks?: Row[] };
  try { doc = JSON.parse(run.stdout); } catch { throw new Error(`doctor ${args.join(' ')} printed no JSON (exit ${run.exitCode}): ${run.stderr.slice(0, 800)}`); }
  const checks = doc.checks ?? [];
  return { exitCode: run.exitCode, statuses: Object.fromEntries(checks.map(c => [c.name, c.status])), row: checks.find(c => c.name === CHECK) };
}

/** What `gbrain search Beta` shows: both pages (alpha mentions beta), and whether it fell to the no-literal-match notice. */
async function searchBeta(): Promise<{ exitCode: number; pages: string[]; keywordZero: boolean; detail: string }> {
  const run = await cli(['search', 'Beta']);
  const pages = [...run.stdout.matchAll(/^\[[0-9.]+\] (\S+) --/gm)].map(m => m[1]!).sort();
  return { exitCode: run.exitCode, pages, keywordZero: /keyword_zero|No page contains these words/.test(run.stderr + run.stdout),
    detail: run.exitCode === 0 ? '' : run.stderr.slice(0, 600) };
}

async function startOwner(): Promise<void> {
  const proc = Bun.spawn(['bun', 'run', CLI, 'serve'], { cwd: home, env: env(), stdin: 'pipe', stdout: 'ignore', stderr: 'pipe' });
  owner = proc;
  const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let seen = '';
  const deadline = Date.now() + 90_000;
  // The owner has taken the brain and listens once serve has started its commit notifier.
  let pending = reader.read();
  while (!/\[serve-sync\] on-commit/.test(seen)) {
    if (Date.now() > deadline) throw new Error(`gbrain serve did not start: ${seen.slice(0, 800)}`);
    const chunk = await Promise.race([pending, Bun.sleep(1000).then(() => null)]);
    if (!chunk) continue; // keep the same read pending, so no stderr chunk is lost
    if (chunk.done) throw new Error(`gbrain serve exited: ${seen.slice(0, 800)}`);
    seen += decoder.decode(chunk.value);
    if (!/\[serve-sync\] on-commit/.test(seen)) pending = reader.read();
  }
  reader.releaseLock();
  // Keep draining serve's stderr so a full pipe never blocks it.
  (proc.stderr as ReadableStream<Uint8Array>).pipeTo(new WritableStream()).catch(() => undefined);
}

async function stopOwner(): Promise<void> {
  if (!owner) return;
  owner.kill('SIGTERM');
  await owner.exited;
  owner = null;
}

const OK_SEARCH = { exitCode: 0, pages: ['alpha', 'beta'], keywordZero: false, detail: '' };

describe.skipIf(!HAVE_ADDON || !HAVE_CARGO)('gbrain doctor on a damaged Rust keyword index', () => {
  beforeAll(async () => {
    fault = process.env.GBRAIN_TEST_DERIVED_FAULT || '';
    if (!fault) {
      const build = Bun.spawnSync(['cargo', 'build', '-q', '-p', 'gbrain-store', '--example', 'derived_fault', '--message-format', 'json'],
        { cwd: join(ROOT, 'rust'), stdout: 'pipe', stderr: 'pipe' });
      if (build.exitCode !== 0) throw new Error(`cargo build --example derived_fault: ${build.stderr.toString().slice(0, 2000)}`);
      for (const line of build.stdout.toString().split('\n')) {
        if (!line.includes('"compiler-artifact"') || !line.includes('derived_fault')) continue;
        const exe = JSON.parse(line).executable;
        if (exe) fault = exe;
      }
      if (!fault) throw new Error('cargo built derived_fault but named no executable');
    }
    home = mkdtempSync(join(tmpdir(), 'gb-rust-derived-'));
    db = join(home, 'brain.rust');
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    mkdirSync(join(home, 'skills'), { recursive: true });
    mkdirSync(join(home, 'notes'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'rust', database_path: db }));
    writeFileSync(join(home, 'notes', 'alpha.md'), '---\ntitle: Alpha\ntype: note\n---\n# Alpha\nAlpha links to [[beta]].\n');
    writeFileSync(join(home, 'notes', 'beta.md'), '---\ntitle: Beta\ntype: note\n---\n# Beta\nBeta body.\n');
    for (const args of [['init', '--migrate-only'], ['import', join(home, 'notes'), '--no-embed']]) {
      const run = await cli(args);
      if (run.exitCode !== 0) throw new Error(`${args[0]} exited ${run.exitCode}: ${run.stderr.slice(0, 800)}`);
    }
    expect(await searchBeta()).toEqual(OK_SEARCH);
  }, 600_000);

  afterAll(async () => {
    await stopOwner().catch(() => undefined);
    if (home) rmSync(home, { recursive: true, force: true });
  });

  const DRILLS = [
    { mode: 'drop-chunk-postings', status: 'fail', keyword: 'mismatch', searchBefore: { exitCode: 0, keywordZero: true } },
    { mode: 'garbage-state', status: 'warn', keyword: 'unreadable', searchBefore: { exitCode: 0, keywordZero: false } },
  ] as const;

  // Value: protects=doctor on a sound Rust brain reports its keyword index ok; fails_when=the row is missing or the check misreads a complete index; why_new=no doctor check reads the Rust keyword index; seam=none; no_claim=the core term postings (T)
  test('a sound brain: doctor reports the keyword index ok', async () => {
    const row = (await doctor(['--only', CHECK])).row;
    expect({ status: row?.status, keyword: row?.details?.keyword?.status }).toEqual({ status: 'ok', keyword: 'ok' });
  }, 600_000);

  for (const drill of DRILLS) {
    // Value: protects=a damaged keyword index is a named doctor finding the CLI and the owner report alike, and --fix repairs it writing only index records; fails_when=doctor has no row or ok, the open refuses, the two paths differ, or the rebuild writes a record; why_new=no CLI doctor test damages a Rust store; seam=the dev-only derived_fault example; no_claim=the core term postings (T), never checked
    test(`${drill.mode}: doctor reports ${drill.keyword} the same with and without an owner, and --fix repairs it with no record write`, async () => {
      damage(drill.mode);
      const before = await searchBeta();
      expect({ exitCode: before.exitCode, keywordZero: before.keywordZero }).toEqual(drill.searchBefore);

      const solo = await doctor([]);
      expect({ status: solo.row?.status, keyword: solo.row?.details?.keyword?.status }).toEqual({ status: drill.status, keyword: drill.keyword });
      await startOwner();
      let owned: Awaited<ReturnType<typeof doctor>>;
      try { owned = await doctor([]); } finally { await stopOwner(); }
      expect(owned.statuses).toEqual(solo.statuses);
      expect(owned.exitCode).toBe(solo.exitCode);

      // The rebuild changes only the index's records: a doctor run without --fix changes nothing, and one with it only `R`.
      const d0 = digest();
      expect((await doctor(['--only', CHECK])).row?.status).toBe(drill.status);
      const d1 = digest();
      const fixed = await doctor(['--fix', '--only', CHECK]);
      const d2 = digest();
      expect(changedTags(d0, d1)).toEqual([]);
      expect(changedTags(d1, d2)).toEqual([INDEX_TAG]);
      expect({ status: fixed.row?.status, keyword: fixed.row?.details?.keyword?.status, record_writes: fixed.row?.details?.rebuild?.record_writes })
        .toEqual({ status: 'ok', keyword: 'ok', record_writes: 0 });
      expect(await searchBeta()).toEqual(OK_SEARCH);
    }, 600_000);

    // Value: protects=--fix through a running owner rebuilds the owner's index (the member is forwarded over the owner socket); fails_when=the rebuild is refused or not forwarded, or search through the owner stays wrong; why_new=the rebuild is a new owner-forwarded member; seam=the dev-only derived_fault example; no_claim=a rebuild racing the owner's own background build
    test(`${drill.mode}: --fix through a running owner repairs it and search through the owner is right`, async () => {
      damage(drill.mode);
      await startOwner();
      let fixed: Awaited<ReturnType<typeof doctor>>;
      let after: Awaited<ReturnType<typeof searchBeta>>;
      try {
        fixed = await doctor(['--fix', '--only', CHECK]);
        after = await searchBeta();
      } finally { await stopOwner(); }
      expect({ status: fixed.row?.status, record_writes: fixed.row?.details?.rebuild?.record_writes }).toEqual({ status: 'ok', record_writes: 0 });
      expect(after).toEqual(OK_SEARCH);
      expect((await doctor(['--only', CHECK])).row?.status).toBe('ok');
    }, 600_000);
  }
});
