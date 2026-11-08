/**
 * L5 (GST-1502): the busy-agent soak cell, the convergence harness under the workload a busy personal agent puts on
 * one managed checkout. It shares the real-process brain of the managed-sync convergence gate
 * (test/helpers/convergence-brain.ts: Postgres behind transaction-mode PgBouncer through latency proxies, real
 * `src/cli.ts` processes, a resident serve, the acknowledged-write ledger and the oracle), and its counts and cadences
 * come from a committed generic profile (test/fixtures/busy-agent-profile.json; GBRAIN_TEST_BUSY_AGENT_PROFILE points
 * at another, such as a private one derived from a real deployment).
 *
 * Modes (MODES below; GBRAIN_TEST_BUSY_AGENT_MODES=h,m runs exactly those):
 *   (h) scheduled `sources refresh` ticks with foreground writes inside the fence: with persistence.refresh_barrier on,
 *       a write that reaches the checkout while a refresh holds it is answered pending and commits after the refresh,
 *       or ends revision_conflict when the refresh changed its file;
 *   (i) plain-git committers and uncommitted-file writers beside gbrain: doctor foreign_writers names every commit
 *       gbrain did not make and none it made;
 *   (j) legacy rows with no import record in every direction: `sources git-gap` classifies each by content evidence;
 *   (k) a strict conversion with live door writers and a refresh between adopt groups;
 *   (l) a segmented page whose staging expires between staging and publication: the write refuses
 *       body_staging_expired, the page keeps its body, a resend commits and the sweep leaves no live staging;
 *   (m) the lost-update race between a file-writing cron and an MCP write to the same page: edit_page refuses
 *       revision_conflict and `git commit-push --base` refuses commit_base_moved, and no acknowledged write is
 *       silently reverted.
 *
 * Every scenario ends with the convergence gate's oracle (a fresh serve, at most two plain syncs, disk == database,
 * no open request, registered terminal codes, the cursor at HEAD, the ledger and the status oracle). The cell is
 * informational in .github/workflows/convergence-nightly.yml for seven nights, then gates releases that touch
 * persistence, sync or Git. Setup: scripts/persistence/README.md ("Busy-agent soak cell"). It is skipped unless
 * GBRAIN_TEST_BUSY_AGENT=1.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { FOREIGN_DIRTY_WARN_MS } from '../src/commands/doctor/checks/foreign-writers.ts';
import { inlineExportMarkdown, readExportPage, readExportWithdrawals } from '../src/core/export-snapshot.ts';
import { GIT_HOLD_OP, SYNC_IMPORT_PROVENANCE_OP } from '../src/core/persistence/sync-holds.ts';
import { CODES } from '../src/core/error-registry.ts';
import { CONVERSION_GROUP_MAX } from '../src/core/persistence/git-conversion.ts';
import { sweepSegmentStorage } from '../src/core/persistence/journal.ts';
import { withEnv } from './helpers/with-env.ts';
import {
  Brain as HarnessBrain, SOURCE, StdioServe, as, fileHash, lastJson, noteMarker, noteSlug, noteText, oracleTests, until,
  type Fault, type HarnessKnobs, type SyncRun,
} from './helpers/convergence-brain.ts';

const REPO_ROOT = resolve(import.meta.dir, '..');
const knob = (name: string, fallback: number): number => {
  const raw = process.env[`GBRAIN_TEST_BUSY_AGENT_${name}`];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`GBRAIN_TEST_BUSY_AGENT_${name} must be a non-negative integer, got '${raw}'.`);
  return value;
};
const SEED = knob('SEED', 8800);
const LATENCY_MS = knob('LATENCY_MS', 50);
const SYNC_TIMEOUT_MS = knob('SYNC_TIMEOUT_MS', 900_000);
const SCENARIO_TIMEOUT_MS = knob('SCENARIO_TIMEOUT_MS', 3_600_000);
const PROFILE_PATH = process.env.GBRAIN_TEST_BUSY_AGENT_PROFILE || join(REPO_ROOT, 'test/fixtures/busy-agent-profile.json');
const pooledTarget = process.env.GBRAIN_PGBOUNCER_URL;
const directTarget = process.env.GBRAIN_PGBOUNCER_DIRECT_URL;
const enabled = process.env.GBRAIN_TEST_BUSY_AGENT === '1';
if (enabled && !(pooledTarget && directTarget)) {
  throw new Error('GBRAIN_TEST_BUSY_AGENT=1 needs GBRAIN_PGBOUNCER_URL (transaction-mode PgBouncer) and GBRAIN_PGBOUNCER_DIRECT_URL (the Postgres behind it).');
}
const LOG_DIR = process.env.GBRAIN_TEST_BUSY_AGENT_LOG_DIR;

// ---------------------------------------------------------------- the profile

/** Counts and cadences only: the shape of a busy agent's day, never its content. */
const PROFILE_SHAPE = {
  notes: 'pages in the checkout',
  refresh_ticks: '(h) scheduled refresh ticks',
  upstream_commits_per_tick: '(h) notes another clone changes and pushes before each tick',
  fence_writes_per_tick: '(h) foreground puts of unchanged notes while the tick holds the fence',
  fence_conflicts_per_tick: '(h) foreground puts of notes the tick changes, while it holds the fence',
  background_write_interval_ms: '(h) cadence of the agent puts that run across every tick',
  plain_git_committers: '(i) plain-git committers beside gbrain',
  plain_git_commits_each: '(i) commits per plain-git committer',
  uncommitted_files: '(i) page files an uncommitted-file writer leaves behind',
  legacy_rows_per_direction: '(j) legacy rows per evidence direction',
  conversion_groups: '(k) adopt groups of the strict conversion',
  conversion_door_writes: '(k) door writes during the conversion',
  segmented_page_kib: '(l) size of the segmented page',
  segmented_writes: '(l) writes to the segmented page after the expired one',
  lost_update_rounds: '(m) free-running rounds of the cron and the MCP writer',
  cron_interval_ms: '(m) cadence of the file-writing cron',
  agent_interval_ms: '(m) cadence of the MCP writer',
} as const;
type Profile = Record<keyof typeof PROFILE_SHAPE, number>;
/** The profile file: a JSON object of exactly PROFILE_SHAPE's keys, each a positive integer, plus an optional `description`. */
function readProfile(raw: string, where: string): Profile {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const problems = [
    ...Object.keys(parsed).filter(key => key !== 'description' && !(key in PROFILE_SHAPE)).map(key => `unknown key ${key}`),
    ...Object.keys(PROFILE_SHAPE).filter(key => !Number.isInteger(parsed[key]) || (parsed[key] as number) < 1).map(key => `${key} must be a positive integer, got ${JSON.stringify(parsed[key])}`),
  ];
  if (problems.length) throw new Error(`busy-agent profile ${where}: ${problems.join('; ')}`);
  return Object.fromEntries(Object.keys(PROFILE_SHAPE).map(key => [key, parsed[key]])) as Profile;
}
const PROFILE = readProfile(readFileSync(PROFILE_PATH, 'utf8'), PROFILE_PATH);

// ---------------------------------------------------------------- modes

const MODES = {
  h: { title: 'scheduled sources refresh ticks with foreground writes inside the fence', skip: null },
  i: { title: 'plain-git committers and uncommitted-file writers beside gbrain', skip: null },
  j: { title: 'legacy rows with no import record in every direction', skip: null },
  k: { title: 'a strict conversion with live door writers and a refresh between adopt groups', skip: null },
  l: { title: 'a segmented page whose staging expires between staging and publication', skip: null },
  m: { title: 'the lost-update race between a file-writing cron and an MCP write to the same page', skip: null },
} as const satisfies Record<string, { title: string; skip: string | null }>;
type Mode = keyof typeof MODES;
const requestedModes = process.env.GBRAIN_TEST_BUSY_AGENT_MODES?.split(',').map(mode => mode.trim()).filter(Boolean);
for (const mode of requestedModes ?? []) if (!(mode in MODES)) throw new Error(`GBRAIN_TEST_BUSY_AGENT_MODES names unknown mode '${mode}' (known: ${Object.keys(MODES).join(', ')}).`);
const runs = (mode: Mode): boolean => requestedModes ? requestedModes.includes(mode) : MODES[mode].skip === null;

const KNOBS: HarnessKnobs = {
  tag: 'busy-agent', seed: SEED, latencyMs: LATENCY_MS, syncTimeoutMs: SYNC_TIMEOUT_MS, logDir: LOG_DIR,
  pooledTarget: pooledTarget ?? '', directTarget: directTarget ?? '', summary: `profile ${PROFILE_PATH}; latency ${LATENCY_MS} ms`,
  repro: modes => `GBRAIN_TEST_BUSY_AGENT=1 GBRAIN_TEST_BUSY_AGENT_SEED=${SEED} GBRAIN_TEST_BUSY_AGENT_MODES=${modes.join(',')} GBRAIN_TEST_BUSY_AGENT_LATENCY_MS=${LATENCY_MS} GBRAIN_PGBOUNCER_URL="$GBRAIN_PGBOUNCER_URL" GBRAIN_PGBOUNCER_DIRECT_URL="$GBRAIN_PGBOUNCER_DIRECT_URL" bun test test/busy-agent-soak.serial.test.ts`,
};
class Brain extends HarnessBrain { constructor(name: string, modes: Mode[]) { super(name, modes, KNOBS); } }

/** A describe that runs when its mode runs; skipped (with its skip reason in the title) otherwise. */
function scenario(mode: Mode, title: string, body: () => void): void {
  const skip = MODES[mode].skip;
  (enabled && runs(mode) ? describe : describe.skip)(`${title} [(${mode})]${!(enabled && runs(mode)) && skip ? ` (skipped until ${skip})` : ''}`, body);
}

// ---------------------------------------------------------------- shared steps

interface Receipt { state: string | null; error_code: string | null; deferred_refresh_id: string | null; completed_at: string | null }
/** A request's row by the caller's request id, read from the journal (null before it was journaled or when it was refused at admission). */
async function receipt(b: Brain, requestId: string): Promise<Receipt | null> {
  const [row] = await b.engine!.executeRaw<Receipt>(
    `SELECT state, error_code, deferred_refresh_id::text, completed_at::text FROM persistence_requests WHERE request_id=$1::uuid ORDER BY sequence DESC LIMIT 1`, [requestId]);
  return row ?? null;
}
const TERMINAL = new Set(['committed', 'conflict', 'failed', 'cancelled']);
/** The error code a CLI refusal printed (`(code)` or `"code":`), for reports. */
function printedCode(r: { out: string; err: string }): string {
  const json = lastJson(r.out) ?? lastJson(r.err);
  const code = (json?.error as { code?: string } | undefined)?.code ?? json?.code;
  if (typeof code === 'string') return code;
  return /\b([a-z]+(?:_[a-z]+)+)\b/.exec(r.err)?.[1] ?? 'unknown';
}
function put(b: Brain, slug: string, content: string, requestId: string) {
  return b.spawnCli(['put', slug, '--source-id', SOURCE, '--force', '--request-id', requestId, '--wait-ms', '2000'], { stdin: content });
}
/**
 * Waits for a stalled child to write its fault marker. A child that exits first, or never gets there, fails the
 * scenario with its output kept (`<tag>-unreached.log`) instead of leaving a stall nobody releases.
 */
async function reached(b: Brain, tag: string, run: SyncRun, label: string): Promise<void> {
  let exited = false;
  void run.result.then(() => { exited = true; });
  try {
    await until(() => exited || existsSync(b.marker(tag)), label, SYNC_TIMEOUT_MS);
  } catch { run.proc.kill('SIGKILL'); }
  if (existsSync(b.marker(tag))) return;
  const r = await run.result;
  b.keepLog(`${tag}-unreached.log`, `exit ${r.code}\n${r.out}\n${r.err}`);
  throw new Error(`${label}: the child ${exited ? `exited ${r.code}` : 'timed out'} first\n${r.out.slice(-2000)}\n${r.err.slice(-4000)}\n${b.context()}`);
}
/** Commits files in a clone that is not the managed checkout (the upstream another agent pushes to). */
function cloneGit(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function writeInto(root: string, slug: string, content: string): void {
  mkdirSync(dirname(join(root, `${slug}.md`)), { recursive: true });
  writeFileSync(join(root, `${slug}.md`), content);
}
/**
 * A busy agent's checkout is Git-durable: the owner commits every page write through its Git effect. The harness records
 * the setting the way `gbrain sources writer git-durability --enable` does, without its push probe (a checkout with no
 * remote commits locally). Each scenario's database holds this one checkout's binding.
 */
async function durable(b: Brain): Promise<void> {
  await b.engine!.executeRaw("UPDATE persistence_host_bindings SET git_durability='enabled'");
}
/** Seeds the notes, publishes them to a bare origin the checkout tracks, and clones that origin as the upstream writer. */
function seedTracked(b: Brain, notes: number): { origin: string; upstream: string } {
  const origin = join(b.home, 'origin.git'), upstream = join(b.home, 'upstream');
  b.writeNotes(Array.from({ length: notes }, (_, i) => i), 'Initial', 'fixture');
  execFileSync('git', ['init', '-q', '--bare', origin]);
  b.git('remote', 'add', 'origin', origin);
  b.git('push', '-q', '-u', 'origin', 'HEAD');
  execFileSync('git', ['clone', '-q', origin, upstream], { stdio: 'ignore' });
  return { origin, upstream };
}

// ---------------------------------------------------------------- always-on calibration

describe('busy-agent cell calibration (L5, GST-1502)', () => {
  test('the committed profile names every count and cadence, and nothing else', () => {
    const committed = readProfile(readFileSync(join(REPO_ROOT, 'test/fixtures/busy-agent-profile.json'), 'utf8'), 'committed');
    expect(Object.keys(committed).sort()).toEqual(Object.keys(PROFILE_SHAPE).sort());
  });
  test('a profile with an unknown key, a missing count or a non-integer is refused', () => {
    const good = readFileSync(join(REPO_ROOT, 'test/fixtures/busy-agent-profile.json'), 'utf8');
    const edit = (patch: (p: Record<string, unknown>) => void) => { const p = JSON.parse(good) as Record<string, unknown>; patch(p); return JSON.stringify(p); };
    expect(() => readProfile(edit(p => { p.page_titles = 3; }), 't')).toThrow('unknown key page_titles');
    expect(() => readProfile(edit(p => { delete p.notes; }), 't')).toThrow('notes must be a positive integer');
    expect(() => readProfile(edit(p => { p.refresh_ticks = 1.5; }), 't')).toThrow('refresh_ticks must be a positive integer');
  });
  test('every mode runs: none is skipped', () => {
    expect(Object.entries(MODES).filter(([, mode]) => mode.skip !== null).map(([name]) => name)).toEqual([]);
  });
});

// ---------------------------------------------------------------- (h) refresh ticks with writes inside the fence

scenario('h', 'writes that reach a refreshing checkout wait for the refresh and then commit or conflict', () => {
  const b = new Brain('refresh-fence', ['h']);
  interface FenceWrite { tick: number; slug: string; requestId: string; expect: 'committed' | 'revision_conflict'; exit: number; printed: string; start: number; receipt: Receipt | null }
  const fenceWrites: FenceWrite[] = [];
  const refreshes: Array<{ tick: number; exit: number; outcome: string; state: string | null; released: string | null }> = [];
  beforeAll(async () => {
    let upstream = '';
    await b.setup(brain => { upstream = seedTracked(brain, PROFILE.notes).upstream; }, { 'persistence.refresh_barrier': 'true' });
    await durable(b);
    const serve = new StdioServe(b);
    await serve.start();
    // The agent writes the first half of the notes; the other clone changes the second half, so a refresh never has to
    // merge two edits of one file. Only the fence conflicts write a note the tick changes, and those apply nothing.
    const half = Math.floor(PROFILE.notes / 2);
    let done = false;
    const background = (async () => {
      for (let k = 0; !done; k++) {
        const slug = noteSlug(b.between(0, half - 1)), marker = `Agent put ${k} of ${slug} (${randomUUID().slice(0, 8)})`;
        const requestId = randomUUID(), start = performance.now();
        const r = await put(b, slug, `---\ntype: concept\ntitle: Agent ${k}\n---\n\n${marker}.\n`, requestId).result;
        b.keepLog(`agent-put-${k}.log`, `exit ${r.code}\n${r.out}\n${r.err}`);
        if (r.code === 0) b.ledger.record({ kind: 'put', slug, marker, touches: ['db', 'file'], start, ack: performance.now() });
        else if (r.code === 10) b.pending.push({ write: { kind: 'put', slug, marker, touches: ['db', 'file'], start }, requestId });
        await Bun.sleep(PROFILE.background_write_interval_ms);
      }
    })();
    for (let tick = 1; tick <= PROFILE.refresh_ticks; tick++) {
      const pick = (lo: number, hi: number, n: number) => [...new Set(Array.from({ length: 4 * n }, () => b.between(lo, hi - 1)))].slice(0, n);
      const changed = pick(half, PROFILE.notes, PROFILE.upstream_commits_per_tick);
      const untouched = pick(0, half, PROFILE.fence_writes_per_tick);
      const start = performance.now();
      cloneGit(upstream, 'pull', '-q', '--no-rebase', '--no-edit');
      for (const i of changed) writeInto(upstream, noteSlug(i), noteText(i, `Upstream tick ${tick}`));
      cloneGit(upstream, 'add', '--', ...changed.map(i => `${noteSlug(i)}.md`));
      cloneGit(upstream, 'commit', '-qm', `tick ${tick}: another agent's notes`);
      cloneGit(upstream, 'push', '-q', 'origin', 'HEAD');
      const ack = performance.now();
      for (const i of changed) b.ledger.record({ kind: 'commit', slug: noteSlug(i), marker: noteMarker(i, `Upstream tick ${tick}`), touches: ['db', 'file'], start, ack });
      // The tick's member sync stalls at its first round, so the refresh holds the fence (state syncing) while the writes arrive.
      const tag = `tick-${tick}`, release = join(b.home, `release-${tag}`);
      const fault: Fault = { point: 'sync:round_start', nth: 1, marker: b.marker(tag), action: 'stall', release, ms: 300_000 };
      b.plan.push(`tick ${tick}: stall the refresh's member sync at sync:round_start #1`);
      const refresh = b.spawnCli(['sources', 'refresh', SOURCE, '--json'], { fault });
      await reached(b, tag, refresh, `tick ${tick}'s refresh to reach its member sync`);
      b.recordFault(tag, `tick ${tick} sync:round_start stall`);
      const writes = [
        ...untouched.map(i => ({ i, expect: 'committed' as const })),
        ...changed.slice(0, PROFILE.fence_conflicts_per_tick).map(i => ({ i, expect: 'revision_conflict' as const })),
      ];
      await Promise.all(writes.map(async ({ i, expect: want }) => {
        const slug = noteSlug(i), requestId = randomUUID(), started = performance.now();
        const marker = `Fence write tick ${tick} of ${slug}`;
        const r = await put(b, slug, `---\ntype: concept\ntitle: Fence ${tick}\n---\n\n${marker}.\n`, requestId).result;
        b.keepLog(`fence-${tick}-${slug.replaceAll('/', '_')}.log`, `exit ${r.code}\n${r.out}\n${r.err}`);
        fenceWrites.push({ tick, slug, requestId, expect: want, exit: r.code, printed: r.code === 0 || r.code === 10 ? '' : printedCode(r), start: started, receipt: null });
      }));
      writeFileSync(release, '');
      const r = await refresh.result;
      b.keepLog(`refresh-${tick}.log`, `exit ${r.code}\n${r.out}\n${r.err}`);
      const [row] = await b.engine!.executeRaw<{ state: string; released_at: string | null }>(
        `SELECT state, released_at::text FROM persistence_worktree_refreshes ORDER BY created_at DESC LIMIT 1`);
      refreshes.push({ tick, exit: r.code, outcome: String(lastJson(r.out)?.status ?? lastJson(r.out)?.error ?? 'none'), state: row?.state ?? null, released: row?.released_at ?? null });
      b.note(`tick ${tick}: refresh exit ${r.code} state ${row?.state}; ${writes.length} write(s) inside the fence`);
      for (const w of fenceWrites.filter(f => f.tick === tick)) {
        await until(async () => TERMINAL.has((await receipt(b, w.requestId))?.state ?? ''), `fence write ${w.slug} of tick ${tick} to settle`, 120_000).catch(() => {});
        w.receipt = await receipt(b, w.requestId);
        const marker = `Fence write tick ${tick} of ${w.slug}`;
        if (w.receipt?.state === 'committed') b.ledger.record({ kind: 'put', slug: w.slug, marker, touches: ['db', 'file'], start: w.start, ack: performance.now() });
      }
    }
    done = true;
    await background;
    await serve.stop();
    await b.recover();
    await b.settlePending(async requestId => (await receipt(b, requestId))?.state);
  }, SCENARIO_TIMEOUT_MS);
  afterAll(() => b.teardown());

  test('every tick\'s refresh completed and released its fence', () => b.verdict(refreshes.filter(r => r.exit !== 0 || r.state !== 'completed' || !r.released)
    .map(r => `tick ${r.tick}: refresh exit ${r.exit} outcome ${r.outcome} state ${r.state} released ${r.released}`)));
  test(as('wedge', 'every write that reached the refreshing checkout was answered pending with a receipt naming the refresh, never refused'), () =>
    b.verdict(fenceWrites.filter(w => w.exit !== 10 || !w.receipt?.deferred_refresh_id)
      .map(w => `tick ${w.tick} ${w.slug}: exit ${w.exit}${w.printed ? ` (${w.printed})` : ''}, deferred_refresh_id ${w.receipt?.deferred_refresh_id ?? 'none'}`)));
  test(as('lost_write', 'a fence write to a file the refresh left alone committed after the refresh'), () =>
    b.verdict(fenceWrites.filter(w => w.expect === 'committed' && w.receipt?.state !== 'committed')
      .map(w => `tick ${w.tick} ${w.slug}: ${w.receipt?.state ?? 'no receipt'} ${w.receipt?.error_code ?? ''}`)));
  test(as('lost_write', 'a fence write to a file the refresh changed ended revision_conflict with nothing applied'), () =>
    b.verdict(fenceWrites.filter(w => w.expect === 'revision_conflict' && !(w.receipt?.state === 'conflict' && w.receipt.error_code === 'revision_conflict'))
      .map(w => `tick ${w.tick} ${w.slug}: ${w.receipt?.state ?? 'no receipt'} ${w.receipt?.error_code ?? ''}`)));
  test('every tick put writes inside the fence, so the barrier was exercised', () =>
    b.verdict(fenceWrites.length >= PROFILE.refresh_ticks ? [] : [`${fenceWrites.length} fence write(s) over ${PROFILE.refresh_ticks} tick(s)`]));
  oracleTests(b, () => ({ bigPage: false }));
});

// ---------------------------------------------------------------- (i) plain-git and uncommitted-file writers

scenario('i', 'doctor foreign_writers names every commit made beside gbrain, none gbrain made, and every stale uncommitted page', () => {
  const b = new Brain('foreign-writers', ['i']);
  const plain: Array<{ sha: string; slug: string }> = [];
  const dropped: string[] = [];
  let gbrainShas: string[] = [];
  let check: { status?: string; details?: { foreign?: Array<{ sha: string }>; dirty?: Array<{ path: string; age_ms: number }>; dirty_count?: number; partial?: boolean } } | undefined;
  beforeAll(async () => {
    await b.setup(brain => brain.writeNotes(Array.from({ length: PROFILE.notes }, (_, i) => i), 'Initial', 'fixture'));
    await durable(b);
    const fixtureHead = b.git('rev-parse', 'HEAD');
    const serve = new StdioServe(b);
    await serve.start();
    // The agent writes the first half of the notes through gbrain (its door commits start the commit ledger); the
    // plain-git committers write the second half, so no plain commit races a gbrain write of the same file.
    const half = Math.floor(PROFILE.notes / 2);
    const agentPut = async (k: number) => {
      const slug = noteSlug(k % half), marker = `Agent put ${k} of ${slug} (${randomUUID().slice(0, 8)})`, start = performance.now();
      const requestId = randomUUID();
      const r = await b.spawnCli(['put', slug, '--source-id', SOURCE, '--force', '--request-id', requestId, '--wait-ms', '20000'],
        { stdin: `---\ntype: concept\ntitle: Agent ${k}\n---\n\n${marker}.\n` }).result;
      b.keepLog(`agent-put-${k}.log`, `exit ${r.code}\n${r.out}\n${r.err}`);
      if (r.code === 0) b.ledger.record({ kind: 'put', slug, marker, touches: ['db', 'file'], start, ack: performance.now() });
      else if (r.code === 10) b.pending.push({ write: { kind: 'put', slug, marker, touches: ['db', 'file'], start }, requestId });
      return r.code;
    };
    if (await agentPut(0) !== 0) throw new Error(`the first agent put did not commit, so gbrain's commit ledger may not exist\n${b.context()}`);
    await until(() => b.git('rev-list', '--count', `${fixtureHead}..HEAD`) !== '0', 'the first door commit', 120_000);
    let done = false;
    const agent = (async () => { for (let k = 1; !done; k++) { await agentPut(k); await Bun.sleep(PROFILE.background_write_interval_ms); } })();
    const committer = async (c: number) => {
      for (let k = 0; k < PROFILE.plain_git_commits_each; k++) {
        const i = half + b.between(0, PROFILE.notes - half - 1), slug = noteSlug(i), version = `Plain git ${c}.${k}`;
        if (plain.some(p => p.slug === slug)) continue;
        const start = performance.now();
        writeInto(b.repo, slug, noteText(i, version));
        for (let attempt = 1; ; attempt++) {
          try { b.git('add', '--', `${slug}.md`); b.git('commit', '-qm', `committer ${c}: ${version}`, '--', `${slug}.md`); break; }
          catch (error) { if (attempt >= 10) throw error; await Bun.sleep(500); }
        }
        plain.push({ sha: b.git('log', '-1', '--format=%H', '--', `${slug}.md`), slug });
        b.ledger.record({ kind: 'commit', slug, marker: noteMarker(i, version), touches: ['db', 'file'], start, ack: performance.now() });
        await Bun.sleep(b.between(300, 1500));
      }
    };
    await Promise.all(Array.from({ length: PROFILE.plain_git_committers }, (_, c) => committer(c)));
    // The uncommitted-file writer leaves new page files behind, last touched past the warn window.
    const stale = (Date.now() - FOREIGN_DIRTY_WARN_MS - 5 * 60_000) / 1000;
    for (let k = 0; k < PROFILE.uncommitted_files; k++) {
      const slug = `inbox/dropped-${k}`;
      writeInto(b.repo, slug, `---\ntype: note\ntitle: Dropped ${k}\n---\n\nLeft uncommitted by another writer.\n`);
      utimesSync(join(b.repo, `${slug}.md`), stale, stale);
      dropped.push(slug);
    }
    done = true;
    await agent;
    await until(async () => (await b.openRequests()).length === 0, 'the agent writes and their door commits to settle', 300_000).catch(() => {});
    const r = await b.spawnCli(['doctor', '--only', 'foreign_writers', '--json']).result;
    b.keepLog('doctor-foreign-writers.json', `exit ${r.code}\n${r.out}\n${r.err}`);
    check = ((lastJson(r.out)?.checks ?? []) as Array<typeof check & { name: string }>).find(c => c?.name === 'foreign_writers');
    gbrainShas = b.git('rev-list', `${fixtureHead}..HEAD`).split('\n').filter(sha => sha && !plain.some(p => p.sha === sha));
    b.note(`${plain.length} plain commit(s), ${gbrainShas.length} gbrain commit(s), ${dropped.length} uncommitted file(s); foreign_writers ${check?.status}`);
    await serve.stop();
    await b.recover();
    await b.settlePending(async requestId => (await receipt(b, requestId))?.state);
  }, SCENARIO_TIMEOUT_MS);
  afterAll(() => b.teardown());

  test('foreign_writers fails and names every plain-git commit', () => {
    const named = new Set((check?.details?.foreign ?? []).map(c => c.sha));
    b.verdict([
      ...(check?.status === 'fail' ? [] : [`foreign_writers status ${check?.status ?? 'missing'}, expected fail`]),
      ...(check?.details?.partial ? ['foreign_writers read only part of the checkout (partial)'] : []),
      ...plain.filter(p => !named.has(p.sha)).map(p => `plain commit ${p.sha.slice(0, 12)} (${p.slug}) not named`),
    ]);
  });
  test('foreign_writers names no commit gbrain made', () => {
    const gbrain = new Set(gbrainShas);
    b.verdict((check?.details?.foreign ?? []).filter(c => gbrain.has(c.sha)).map(c => `gbrain commit ${c.sha.slice(0, 12)} named as foreign`));
  });
  test('every stale uncommitted page file is listed past the warn window', () => {
    const listed = new Map((check?.details?.dirty ?? []).map(d => [d.path.replace(/\.md$/, ''), d.age_ms]));
    b.verdict(dropped.filter(slug => ![...listed.keys()].some(path => path.endsWith(slug)) || [...listed.entries()].find(([path]) => path.endsWith(slug))![1] < FOREIGN_DIRTY_WARN_MS)
      .map(slug => `${slug}: not listed as a stale uncommitted page file`));
  });
  oracleTests(b, () => ({ exclude: new Set(dropped), bigPage: false }));
});

// ---------------------------------------------------------------- (j) legacy rows with no import record

scenario('j', 'legacy rows with no import record are classified by content evidence in every direction', () => {
  const b = new Brain('legacy-rows', ['j']);
  const DIRECTIONS = ['adopt_db_moved', 'git_wins_file_moved', 'both_moved', 'no_evidence'] as const;
  const targets = new Map<string, typeof DIRECTIONS[number]>();
  let census: Record<string, unknown> | null = null;
  const after = new Map<string, { file: string; db: string; held: string | null }>();
  beforeAll(async () => {
    await b.setup(brain => brain.writeNotes(Array.from({ length: PROFILE.notes }, (_, i) => i), 'Initial', 'fixture'));
    await durable(b);
    const pool = [...new Set(Array.from({ length: 8 * PROFILE.legacy_rows_per_direction }, () => b.between(0, PROFILE.notes - 1)))];
    DIRECTIONS.forEach((direction, d) => { for (let k = 0; k < PROFILE.legacy_rows_per_direction; k++) targets.set(noteSlug(pool[d * PROFILE.legacy_rows_per_direction + k]!), direction); });
    const slugs = [...targets.keys()];
    // Each file becomes the page's own export, imported once, so the page and its committed blob share a state.
    const rendered = async (slug: string) => b.engine!.transaction(async tx => {
      const [key] = await tx.executeRaw<{ id: string; source_id: string; slug: string }>('SELECT id::text, source_id, slug FROM pages WHERE source_id=$1 AND slug=$2', [SOURCE, slug]);
      return inlineExportMarkdown(await readExportPage(tx, key!, await readExportWithdrawals(tx, SOURCE)));
    });
    for (const slug of slugs) writeFileSync(join(b.repo, `${slug}.md`), await rendered(slug));
    b.git('add', '--', ...slugs.map(slug => `${slug}.md`)); b.git('commit', '-qm', 'files equal their pages', '--', ...slugs.map(slug => `${slug}.md`));
    const imported = await b.sync(['--no-pull', '--no-delegate', '--json']).result;
    if (imported.code !== 0) throw new Error(`the import of the rendered files exited ${imported.code}\n${imported.err}\n${b.context()}`);
    // The rows lose their import records (imported before records existed), then each side moves as its direction says.
    await withEnv({ GBRAIN_HOME: b.home }, async () => {
      await b.engine!.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      try {
        await b.engine!.executeRaw(`DELETE FROM op_checkpoints WHERE op=$1 AND completed_keys->0->>'page_id' IN (SELECT id::text FROM pages WHERE source_id=$2 AND slug = ANY($3::text[]))`,
          [SYNC_IMPORT_PROVENANCE_OP, SOURCE, slugs]);
        for (const [slug, direction] of targets) {
          if (direction === 'git_wins_file_moved') continue;
          if (direction !== 'no_evidence') await b.engine!.createVersion(slug, { sourceId: SOURCE });
          const start = performance.now();
          await b.engine!.putPage(slug, { type: 'concept', title: slug.split('/')[1]!, compiled_truth: `Edited in the database (${direction}).`, timeline: '' }, { sourceId: SOURCE });
          b.ledger.record({ kind: 'db_only', slug, marker: `Edited in the database (${direction}).`, touches: ['db'], start, ack: performance.now() });
        }
      } finally { await b.engine!.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1'); }
    });
    const fileMoved = [...targets].filter(([, d]) => d !== 'adopt_db_moved').map(([slug]) => slug);
    for (const slug of fileMoved) writeFileSync(join(b.repo, `${slug}.md`), noteText(Number(slug.slice(-4)), `Plain git edit (${targets.get(slug)})`));
    const editStart = performance.now();
    b.git('add', '--', ...fileMoved.map(slug => `${slug}.md`)); b.git('commit', '-qm', 'plain git edits', '--', ...fileMoved.map(slug => `${slug}.md`));
    // A held file never reaches its page, so a plain edit of a row whose page also moved lands in the file alone.
    for (const slug of fileMoved) b.ledger.record({ kind: 'commit', slug, marker: noteMarker(Number(slug.slice(-4)), `Plain git edit (${targets.get(slug)})`),
      touches: targets.get(slug) === 'git_wins_file_moved' ? ['db', 'file'] : ['file'], start: editStart, ack: performance.now() });
    const r = await b.spawnCli(['sources', 'git-gap', SOURCE, '--json', '--sample', String(4 * targets.size + 20)]).result;
    b.keepLog('git-gap.json', `exit ${r.code}\n${r.out}\n${r.err}`);
    census = lastJson(r.out);
    b.note(`git-gap: direction_evidence ${JSON.stringify(census?.direction_evidence)}`);
    await b.recover();
    const disk = b.diskPages(), db = await b.dbPages();
    const holds = await b.engine!.executeRaw<{ record: Record<string, unknown> }>(`SELECT completed_keys->0 AS record FROM op_checkpoints WHERE op=$1`, [GIT_HOLD_OP]);
    for (const slug of slugs) after.set(slug, { file: disk.get(slug) ?? '', db: db.get(slug)?.body ?? '', held: (holds.find(h => h.record.slug === slug)?.record.code as string | undefined) ?? null });
    for (const [slug, state] of after) b.note(`${targets.get(slug)} ${slug}: held ${state.held}; db ${JSON.stringify(state.db.slice(0, 60))}; file ${JSON.stringify(state.file.slice(-60))}`);
  }, SCENARIO_TIMEOUT_MS);
  afterAll(() => b.teardown());

  test('sources git-gap classifies every legacy row by the side that moved', () => {
    const samples = new Map(((census?.samples ?? census?.sample ?? []) as Array<{ slug: string; evidence?: string }>).map(s => [s.slug, s.evidence]));
    b.verdict([
      ...(census?.complete === true ? [] : [`git-gap census incomplete or missing: ${JSON.stringify(census)?.slice(0, 300)}`]),
      ...[...targets].filter(([slug, want]) => samples.get(slug) !== want).map(([slug, want]) => `${slug}: evidence ${samples.get(slug) ?? 'none'}, expected ${want}`),
      ...DIRECTIONS.filter(d => (census?.direction_evidence as Record<string, number> | null)?.[d] !== PROFILE.legacy_rows_per_direction)
        .map(d => `direction_evidence.${d} is ${(census?.direction_evidence as Record<string, number> | null)?.[d]}, expected ${PROFILE.legacy_rows_per_direction}`),
    ]);
  });
  test(as('lost_write', 'the sync after the census overwrote no database move: a legacy row whose page moved keeps it'), () =>
    b.verdict([...targets].filter(([slug, d]) => d !== 'git_wins_file_moved' && !after.get(slug)?.db.includes(`Edited in the database (${d}).`))
      .map(([slug, d]) => `${d} ${slug}: the page lost its database edit (${JSON.stringify(after.get(slug)?.db.slice(0, 80))})`)));
  test('a row only the file moved imports the file; a row both sides moved is held file_drift for a person', () =>
    b.verdict([...targets].flatMap(([slug, d]) => {
      const state = after.get(slug)!;
      if (d === 'git_wins_file_moved') return state.db.includes('Plain git edit') && !state.held ? [] : [`${slug}: the file move was not imported (held ${state.held})`];
      if (d === 'adopt_db_moved') return state.held ? [`${slug}: held ${state.held} although its file never changed`] : [];
      return state.held === 'file_drift' ? [] : [`${d} ${slug}: held ${state.held}, expected file_drift`];
    })));
  oracleTests(b, () => {
    const held = [...targets].filter(([, d]) => d === 'both_moved' || d === 'no_evidence').map(([slug]) => slug);
    return { exclude: new Set([...targets].filter(([, d]) => d !== 'git_wins_file_moved').map(([slug]) => slug)), bigPage: false,
      status: { holds: held.map(slug => ({ code: 'file_drift', path: `${slug}.md` })), needsHuman: held.length > 0 } };
  });
});

// ---------------------------------------------------------------- (k) a strict conversion under live writers

scenario('k', 'a strict conversion with live door writers and a refresh between adopt groups converts and loses nothing', () => {
  const b = new Brain('strict-conversion', ['k']);
  const adoptCount = (PROFILE.conversion_groups - 1) * CONVERSION_GROUP_MAX + 10;
  const notes = Math.max(PROFILE.notes, adoptCount + 40);
  const upstreamNotes = [adoptCount, adoptCount + 1, adoptCount + 2], doorBase = adoptCount + 20;
  let preview: Record<string, unknown> | null = null;
  const applies: Array<{ exit: number; status: string; code: string | null; closing: unknown }> = [];
  const refreshes: Array<{ when: string; exit: number; status: string; code: string }> = [];
  const doorWrites: Array<{ slug: string; exit: number; code: string }> = [];
  let upstreamHead = '', strictAfter = false, remainingAfter: unknown = null;
  const canonical = (args: string[], fault?: Fault) => b.spawnCli(['sources', 'canonical', SOURCE, '--to', 'git', ...args, '--json'], { fault });
  const refresh = async (when: string) => {
    const r = await b.spawnCli(['sources', 'refresh', SOURCE, '--json']).result;
    b.keepLog(`refresh-${when}.log`, `exit ${r.code}\n${r.out}\n${r.err}`);
    refreshes.push({ when, exit: r.code, status: String(lastJson(r.out)?.status ?? 'none'), code: r.code === 0 ? '' : String(lastJson(r.out)?.code ?? printedCode(r)) });
  };
  const apply = async (hash: string, fault?: Fault, tag?: string) => {
    const run = canonical(['--apply', '--expect', hash, '--no-extract'], fault);
    return { run, done: async () => {
      const r = await run.result;
      b.keepLog(`apply-${applies.length + 1}.log`, `exit ${r.code}\n${r.out.slice(-20000)}\n${r.err.slice(-20000)}`);
      const out = lastJson(r.out);
      applies.push({ exit: r.code, status: String(out?.status ?? 'none'), code: (out?.code as string | undefined) ?? null, closing: (out?.result as Record<string, unknown> | undefined)?.closing_passes ?? null });
      if (tag) b.recordFault(tag, 'apply: conversion:group_committed stall');
    } };
  };
  const previewHash = async () => {
    const r = await canonical(['--dry-run']).result;
    b.keepLog(`preview-${applies.length}.json`, `exit ${r.code}\n${r.out.slice(-20000)}\n${r.err.slice(-4000)}`);
    const printed = lastJson(r.out);
    const out = (printed?.preview as Record<string, unknown> | undefined) ?? printed;
    return { out, hash: String(out?.preview_hash ?? '') };
  };
  beforeAll(async () => {
    let upstream = '';
    await b.setup(brain => { upstream = seedTracked(brain, notes).upstream; }, { 'persistence.refresh_barrier': 'true' });
    await durable(b);
    // Rows the database moved since their import: the conversion adopts them into Git, CONVERSION_GROUP_MAX per commit.
    await withEnv({ GBRAIN_HOME: b.home }, async () => {
      await b.engine!.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      try {
        for (let i = 0; i < adoptCount; i++) {
          const start = performance.now(), marker = `Database edit of note ${i}`;
          await b.engine!.putPage(noteSlug(i), { type: 'concept', title: `Note ${i} Example`, compiled_truth: `${marker}, adopted by the conversion.`, timeline: '' }, { sourceId: SOURCE });
          b.ledger.record({ kind: 'db_only', slug: noteSlug(i), marker, touches: ['db', 'file'], start, ack: performance.now() });
        }
      } finally { await b.engine!.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1'); }
    });
    const serve = new StdioServe(b);
    await serve.start();
    const first = await previewHash();
    preview = first.out;
    // Another agent pushes while the conversion runs; the refresh between adopt groups brings it in.
    const pushStart = performance.now();
    cloneGit(upstream, 'pull', '-q', '--no-rebase', '--no-edit');
    for (const i of upstreamNotes) writeInto(upstream, noteSlug(i), noteText(i, 'Upstream during conversion'));
    cloneGit(upstream, 'add', '--', ...upstreamNotes.map(i => `${noteSlug(i)}.md`));
    cloneGit(upstream, 'commit', '-qm', 'another agent during the conversion');
    cloneGit(upstream, 'push', '-q', 'origin', 'HEAD');
    upstreamHead = cloneGit(upstream, 'rev-parse', 'HEAD');
    for (const i of upstreamNotes) b.ledger.record({ kind: 'commit', slug: noteSlug(i), marker: noteMarker(i, 'Upstream during conversion'), touches: ['db', 'file'], start: pushStart, ack: performance.now() });
    const tag = 'between-groups', release = join(b.home, `release-${tag}`);
    b.plan.push('stall the apply after its first adopt group commits (conversion:group_committed #1); refresh and door writes there');
    const stalled = await apply(first.hash, { point: 'conversion:group_committed', nth: 1, marker: b.marker(tag), action: 'stall', release, ms: 300_000 }, tag);
    await reached(b, tag, stalled.run, 'the apply to commit its first adopt group');
    const writers = Array.from({ length: PROFILE.conversion_door_writes }, async (_, k) => {
      const i = doorBase + k, slug = noteSlug(i), marker = `Door write ${k} during the conversion`, start = performance.now(), requestId = randomUUID();
      const r = await b.spawnCli(['put', slug, '--source-id', SOURCE, '--force', '--request-id', requestId, '--wait-ms', '20000'],
        { stdin: `---\ntype: concept\ntitle: Door ${k}\n---\n\n${marker}.\n` }).result;
      b.keepLog(`door-${k}.log`, `exit ${r.code}\n${r.out}\n${r.err}`);
      doorWrites.push({ slug, exit: r.code, code: r.code === 0 || r.code === 10 ? '' : printedCode(r) });
      if (r.code === 0) b.ledger.record({ kind: 'put', slug, marker, touches: ['db', 'file'], start, ack: performance.now() });
      else if (r.code === 10) b.pending.push({ write: { kind: 'put', slug, marker, touches: ['db', 'file'], start }, requestId });
    });
    await refresh('between adopt groups');
    writeFileSync(release, '');
    await Promise.all(writers);
    await stalled.done();
    // An apply that ends incomplete names its rerun (git_conversion_incomplete): one more preview and apply, no fault.
    if (applies.at(-1)?.status !== 'converted') { const again = await previewHash(); await (await apply(again.hash)).done(); }
    if (!refreshes.some(r => r.exit === 0)) await refresh('after the conversion');
    strictAfter = (await b.engine!.executeRaw("SELECT 1 FROM sources WHERE id=$1 AND config->>'canonical'='git'", [SOURCE])).length === 1;
    remainingAfter = (await previewHash()).out?.remaining ?? null;
    b.note(`adopt ${adoptCount} row(s) in ${JSON.stringify(preview?.adopt)}; applies ${JSON.stringify(applies)}; refreshes ${JSON.stringify(refreshes)}; door writes ${JSON.stringify(doorWrites)}; strict ${strictAfter}; remaining ${remainingAfter}`);
    await serve.stop();
    await b.recover();
    await b.settlePending(async requestId => (await receipt(b, requestId))?.state);
  }, SCENARIO_TIMEOUT_MS);
  afterAll(() => b.teardown());

  test('the conversion had more adopt groups than one, so the refresh landed between two of them', () => {
    const groups = (preview?.adopt as { groups?: number } | undefined)?.groups ?? 0;
    b.verdict(groups >= PROFILE.conversion_groups ? [] : [`the preview planned ${groups} adopt group(s), expected at least ${PROFILE.conversion_groups}`]);
  });
  test(as('wedge', 'the conversion converts the source to strict Git-canonical with nothing left to plan'), () =>
    b.verdict([...(applies.at(-1)?.status === 'converted' ? [] : [`the last apply ended ${JSON.stringify(applies.at(-1))}`]),
      ...(strictAfter ? [] : ['the source is not git-canonical']), ...(remainingAfter === 0 ? [] : [`the preview after the conversion has ${remainingAfter} remaining`])]));
  test(as('wedge', 'the refresh between adopt groups, or the one after the conversion, brought in the other agent\'s commit'), () =>
    b.verdict(refreshes.some(r => r.exit === 0) && b.git('merge-base', '--is-ancestor', upstreamHead, 'HEAD') === '' ? [] : [`refreshes ${JSON.stringify(refreshes)}; HEAD does not contain ${upstreamHead.slice(0, 12)}`]));
  test(as('untyped_error', 'every door write and refresh during the conversion was accepted or refused with a registered code'), () =>
    b.verdict([...doorWrites.filter(w => w.exit !== 0 && w.exit !== 10 && !(w.code in CODES)).map(w => `${w.slug}: exit ${w.exit} ${w.code}`),
      ...refreshes.filter(r => r.exit !== 0 && !(r.code in CODES)).map(r => `refresh ${r.when}: exit ${r.exit} ${r.code}`)]));
  oracleTests(b, () => ({ bigPage: false }));
});

// ---------------------------------------------------------------- (l) segmented staging expiry

scenario('l', 'a segmented write whose staging expires or aborts before publication publishes nothing, and a resend commits', () => {
  const b = new Brain('segmented-staging', ['l']);
  const PAGE = 'archive/segmented-log';
  const archive = (version: string) => `---\ntype: note\ntitle: Segmented log\n---\n\n# Segmented log (${version})\n\n` +
    Array.from({ length: Math.ceil(PROFILE.segmented_page_kib * 1024 / 96) }, (_, i) => `Entry ${i} of the ${version} archive, a steady line of synthetic operating detail.\n`).join('');
  const injected: Array<{ how: 'expired' | 'aborted'; staged: string | null; exit: number; code: string; receipt: Receipt | null; kept: boolean }> = [];
  let storage: string | null = null;
  let liveAfterSweep: unknown[] = [];
  let tiling: { status?: string } | undefined;
  /** A segmented page keeps its body in segment rows, not compiled_truth, so the page is compared by content hash. */
  const pageIs = async (version: string) => (await b.dbPages()).get(PAGE)?.hash === fileHash(PAGE, archive(version));
  const putArchive = (version: string, requestId: string, fault?: Fault) =>
    b.spawnCli(['put', PAGE, '--source-id', SOURCE, '--force', '--request-id', requestId, '--wait-ms', '30000'], { stdin: archive(version), fault });
  const sweep = () => withEnv({ GBRAIN_HOME: b.home }, () => sweepSegmentStorage(b.engine!));
  beforeAll(async () => {
    await b.setup(brain => brain.commit('fixture', [
      ...Array.from({ length: Math.min(PROFILE.notes, 20) }, (_, i) => ({ slug: noteSlug(i), content: noteText(i, 'Initial'), marker: noteMarker(i, 'Initial') })),
      { slug: PAGE, content: archive('v0'), marker: 'Segmented log (v0)' }]), { 'pages.segmented_storage': 'on' });
    await durable(b);
    for (const ack of b.ledger.acks) if (ack.slug === PAGE) ack.touches = ['file'];
    storage = (await b.engine!.executeRaw<{ body_storage: string }>('SELECT body_storage FROM pages WHERE source_id=$1 AND slug=$2', [SOURCE, PAGE]))[0]?.body_storage ?? null;
    // Each write stalls once its manifest is staged; the harness then ends its staging the way a sweep (expired) or a
    // fact purge (aborted) does, and releases it into publication.
    for (const how of ['expired', 'aborted'] as const) {
      const tag = `staging-${how}`, release = join(b.home, `release-${tag}`), requestId = randomUUID();
      b.plan.push(`stall the ${how} write at segmented:manifest_staged #1`);
      const write = putArchive(`v-${how}`, requestId, { point: 'segmented:manifest_staged', nth: 1, marker: b.marker(tag), action: 'stall', release, ms: 300_000 });
      await reached(b, tag, write, `the ${how} write to stage its manifest`);
      b.recordFault(tag, `${how}: segmented:manifest_staged stall`);
      if (how === 'expired') {
        await b.engine!.executeRaw(`UPDATE page_body_stagings SET idle_expires_at=now() - interval '1 hour', hard_expires_at=now() - interval '1 minute'
          WHERE source_id=$1 AND slug=$2 AND state IN ('open','sealed','prepared')`, [SOURCE, PAGE]);
        await sweep();
      } else {
        await b.engine!.executeRaw(`UPDATE page_body_stagings SET state='aborted', updated_at=now() WHERE source_id=$1 AND slug=$2 AND state IN ('open','sealed','prepared')`, [SOURCE, PAGE]);
      }
      const [staged] = await b.engine!.executeRaw<{ state: string }>('SELECT state FROM page_body_stagings WHERE source_id=$1 AND slug=$2 ORDER BY created_at DESC LIMIT 1', [SOURCE, PAGE]);
      writeFileSync(release, '');
      const r = await write.result;
      b.keepLog(`${tag}.log`, `exit ${r.code}\n${r.out}\n${r.err}`);
      await until(async () => TERMINAL.has((await receipt(b, requestId))?.state ?? ''), `the ${how} write to settle`, 120_000).catch(() => {});
      injected.push({ how, staged: staged?.state ?? null, exit: r.code, code: r.code === 0 ? '' : printedCode(r), receipt: await receipt(b, requestId), kept: await pageIs('v0') });
    }
    // The resend, then the profile's later writes, each a new version of the whole page.
    for (let k = 0; k <= PROFILE.segmented_writes; k++) {
      const version = `v${k + 1}`, start = performance.now();
      const r = await putArchive(version, randomUUID()).result;
      b.keepLog(`write-${version}.log`, `exit ${r.code}\n${r.out}\n${r.err}`);
      // The ledger reads the file; disk == database (by content hash) carries the page side of a segmented write.
      if (r.code === 0) b.ledger.record({ kind: 'put', slug: PAGE, marker: `Segmented log (${version})`, touches: ['file'], start, ack: performance.now() });
      else b.note(`write ${version}: exit ${r.code} ${printedCode(r)}`);
    }
    await sweep();
    liveAfterSweep = await b.engine!.executeRaw(`SELECT id::text, kind, state FROM page_body_stagings WHERE state IN ('open','sealed','prepared')`);
    const doctor = await b.spawnCli(['doctor', '--only', 'segmented_tiling', '--json']).result;
    b.keepLog('doctor-segmented-tiling.json', `exit ${doctor.code}\n${doctor.out}\n${doctor.err}`);
    tiling = ((lastJson(doctor.out)?.checks ?? []) as Array<{ name: string; status?: string }>).find(c => c.name === 'segmented_tiling');
    b.note(`storage ${storage}; injected ${JSON.stringify(injected.map(i => ({ how: i.how, staged: i.staged, exit: i.exit, code: i.code, receipt: i.receipt?.error_code ?? i.receipt?.state })))}; tiling ${tiling?.status}`);
    await b.recover();
  }, SCENARIO_TIMEOUT_MS);
  afterAll(() => b.teardown());

  test('the page is stored in segments, so the staging path is the one under test', () => b.verdict(storage === 'segmented' ? [] : [`body_storage is ${storage}`]));
  test(as('lost_write', 'a write whose staging expired or aborted before publication refuses body_staging_expired and the page keeps its body'), () =>
    b.verdict(injected.flatMap(i => [
      ...(i.staged === i.how ? [] : [`${i.how}: the staging was ${i.staged} when the write was released`]),
      ...((i.code === 'body_staging_expired' || i.receipt?.error_code === 'body_staging_expired') && i.receipt?.state !== 'committed' ? [] : [`${i.how}: exit ${i.exit} ${i.code}, receipt ${i.receipt?.state} ${i.receipt?.error_code}`]),
      ...(i.kept ? [] : [`${i.how}: the page lost its previous body`]),
    ])));
  test('the sweep leaves no live staging behind', () => b.verdict(liveAfterSweep.map(row => `live staging after the sweep: ${JSON.stringify(row)}`)));
  test(as('projection_drift', 'doctor segmented_tiling finds every segmented page tiled'), () => b.verdict(tiling?.status === 'ok' ? [] : [`segmented_tiling is ${tiling?.status ?? 'missing'}`]));
  oracleTests(b, () => ({ bigPage: false }));
});

// ---------------------------------------------------------------- (m) the lost-update race

scenario('m', 'a file-writing cron and an MCP writer racing on one page lose no acknowledged write', () => {
  const b = new Brain('lost-update', ['m']);
  const BOARD = 'ops/daily-board', PATH = `${BOARD}.md`;
  const board = (entries: string[]) => `---\ntype: note\ntitle: Daily board\n---\n\n# Daily board\n\n${entries.map(e => `- ${e}\n`).join('')}END\n`;
  /**
   * Every refusal either writer met, by code. The race may only produce refusals that apply nothing: commit_base_moved
   * for the cron; for the agent revision_conflict, or source_changed while the file holds the cron's commit before the
   * sync imports it (pending_import) or the cron's bytes before it commits them (an uncoordinated local edit).
   */
  const refusals: Array<{ writer: 'cron' | 'agent'; code: string }> = [];
  const acked: Array<{ writer: 'cron' | 'agent'; marker: string }> = [];
  const forced: Record<'A' | 'B', string | null> = { A: null, B: null };
  let serve!: StdioServe;
  const mcp = async (name: string, args: Record<string, unknown>) => {
    const msg = await serve.request('tools/call', { name, arguments: args });
    const result = msg.result as { isError?: boolean; content?: Array<{ text?: string }> } | undefined;
    const text = result?.content?.[0]?.text ?? JSON.stringify(msg.error ?? null);
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(text) as Record<string, unknown>; } catch { body = { text }; }
    return { isError: result?.isError === true || !!msg.error, body };
  };
  const revision = async () => String((await mcp('get_page', { slug: BOARD, include_content: true, source_id: SOURCE })).body.revision ?? '');
  /** The agent's MCP edit at a revision it read: committed, or the code that refused it (a pending write is followed to its receipt). */
  const agentEdit = async (marker: string, rev: string): Promise<string> => {
    const requestId = randomUUID();
    const r = await mcp('edit_page', { slug: BOARD, source_id: SOURCE, expected_revision: rev, request_id: requestId, edits: [{ old_text: '\nEND\n', new_text: `\n- ${marker}\nEND\n` }] });
    if (r.isError) return String(r.body.code ?? r.body.error ?? 'unknown');
    if (r.body.status === 'pending') {
      await until(async () => TERMINAL.has((await receipt(b, requestId))?.state ?? ''), `the agent edit ${marker} to settle`, 300_000);
      const settled = await receipt(b, requestId);
      if (settled?.state !== 'committed') return settled?.error_code ?? settled?.state ?? 'unknown';
    }
    return 'committed';
  };
  /** The cron's commit of the file it read at HEAD (blob `base`), bound to that blob with --base; a refusal discards its stale bytes. */
  const cronCommit = async (marker: string, read: { base: string; content: string }): Promise<string> => {
    writeFileSync(join(b.repo, PATH), read.content.replace('\nEND\n', `\n- ${marker}\nEND\n`));
    const r = await b.spawnCli(['git', 'commit-push', '--path', b.repo, '--base', `${PATH}=${read.base}`, '-m', `cron: ${marker}`, '--json', '--', PATH]).result;
    b.keepLog(`cron-${marker.replaceAll(' ', '_')}.log`, `exit ${r.code}\n${r.out}\n${r.err}`);
    if (r.code === 0) return 'committed';
    b.git('checkout', '--', PATH);
    return printedCode(r);
  };
  const cronRead = () => ({ base: b.git('rev-parse', `HEAD:${PATH}`), content: b.git('show', `HEAD:${PATH}`) + '\n' });
  const tick = () => b.sync(['--no-pull', '--json']).result;
  /**
   * One writer's acknowledged append, retried from a fresh read after each refusal, at most 20 times. An agent refused
   * because the file holds the cron's commit before the next sync imports it waits for that sync like any client.
   */
  const append = async (writer: 'cron' | 'agent', marker: string) => {
    for (let attempt = 1; attempt <= 20; attempt++) {
      const outcome = writer === 'agent' ? await agentEdit(marker, await revision()) : await cronCommit(marker, cronRead());
      if (outcome === 'committed') { acked.push({ writer, marker }); return; }
      refusals.push({ writer, code: outcome });
      await Bun.sleep(b.between(300, 1500));
    }
  };
  beforeAll(async () => {
    await b.setup(brain => brain.commit('fixture', [
      ...Array.from({ length: Math.min(PROFILE.notes, 20) }, (_, i) => ({ slug: noteSlug(i), content: noteText(i, 'Initial'), marker: noteMarker(i, 'Initial') })),
      { slug: BOARD, content: board(['seeded']), marker: '- seeded' }]), { 'persistence.refresh_barrier': 'true' });
    await durable(b);
    serve = new StdioServe(b);
    await serve.start();
    // Forced order A: the agent reads, the cron commits and the sync imports it, then the agent writes at its stale revision.
    const staleRev = await revision();
    if (await cronCommit('cron forced A', cronRead()) !== 'committed') throw new Error(`forced A: the cron commit was refused\n${b.context()}`);
    acked.push({ writer: 'cron', marker: 'cron forced A' });
    await tick();
    await until(async () => (await revision()) !== staleRev, 'the cron commit to be imported', 120_000);
    forced.A = await agentEdit('agent forced A', staleRev);
    // Forced order B: the cron reads the blob, the agent's edit commits through the door, then the cron commits on its stale read.
    const staleRead = cronRead();
    if (await agentEdit('agent forced B', await revision()) !== 'committed') throw new Error(`forced B: the agent edit was refused\n${b.context()}`);
    acked.push({ writer: 'agent', marker: 'agent forced B' });
    await until(() => b.git('rev-parse', `HEAD:${PATH}`) !== staleRead.base, 'the agent edit\'s door commit', 120_000);
    forced.B = await cronCommit('cron forced B', staleRead);
    // Free-running: both writers on their cadences, and the agent's scheduled sync importing the cron's commits.
    let done = false;
    const ticks = (async () => { while (!done) { await tick(); await Bun.sleep(PROFILE.cron_interval_ms); } })();
    await Promise.all([
      (async () => { for (let k = 0; k < PROFILE.lost_update_rounds; k++) { await append('cron', `cron ${k}`); await Bun.sleep(PROFILE.cron_interval_ms); } })(),
      (async () => { for (let k = 0; k < PROFILE.lost_update_rounds; k++) { await append('agent', `agent ${k}`); await Bun.sleep(PROFILE.agent_interval_ms); } })(),
    ]);
    done = true;
    await ticks;
    b.note(`forced A: ${forced.A}; forced B: ${forced.B}; ${acked.length} acknowledged append(s); refusals ${JSON.stringify(Object.fromEntries([...new Set(refusals.map(r => `${r.writer}:${r.code}`))].map(k => [k, refusals.filter(r => `${r.writer}:${r.code}` === k).length])))}`);
    await serve.stop();
    await b.recover();
  }, SCENARIO_TIMEOUT_MS);
  afterAll(() => b.teardown());

  test(as('lost_write', 'an MCP edit at a revision the cron\'s imported commit moved refuses revision_conflict'), () =>
    b.verdict(forced.A === 'revision_conflict' ? [] : [`forced order A ended ${forced.A}`]));
  test(as('lost_write', 'a commit-push bound to a blob the agent\'s commit moved refuses commit_base_moved'), () =>
    b.verdict(forced.B === 'commit_base_moved' ? [] : [`forced order B ended ${forced.B}`]));
  test(as('lost_write', 'no acknowledged append is silently reverted: every one is in the file and the page'), async () => {
    const file = b.diskPages().get(BOARD) ?? '', page = (await b.dbPages()).get(BOARD)?.body ?? '';
    b.verdict(acked.flatMap(a => [...(file.includes(`- ${a.marker}\n`) ? [] : [`${a.writer} append ${a.marker}: missing from the file`]),
      ...(page.includes(`- ${a.marker}`) ? [] : [`${a.writer} append ${a.marker}: missing from the page`])]));
  });
  test('every refusal the free-running writers met is the race\'s own and applied nothing', () =>
    b.verdict(refusals.filter(r => !(r.writer === 'agent' ? ['revision_conflict', 'source_changed'].includes(r.code) : r.code === 'commit_base_moved'))
      .map(r => `${r.writer} refused ${r.code}`)));
  test('both writers got every append in', () =>
    b.verdict((['cron', 'agent'] as const).filter(w => acked.filter(a => a.writer === w && /^\w+ \d+$/.test(a.marker)).length !== PROFILE.lost_update_rounds)
      .map(w => `${w}: ${acked.filter(a => a.writer === w && /^\w+ \d+$/.test(a.marker)).length} of ${PROFILE.lost_update_rounds} appends acknowledged`)));
  oracleTests(b, () => ({ bigPage: false }));
});
