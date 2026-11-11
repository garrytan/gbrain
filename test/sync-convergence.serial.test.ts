/**
 * #6650 L0 / #6712 PR 0: the managed-sync convergence gate.
 *
 * Each scenario builds one isolated Postgres brain behind PgBouncer in
 * transaction mode, reached by every child process through a TCP proxy in this
 * file that adds GBRAIN_TEST_CONVERGENCE_LATENCY_MS (default 50) of round-trip
 * latency to the pooled URL and to the direct URL (GBRAIN_DIRECT_DATABASE_URL).
 * The managed fixture is GBRAIN_TEST_CONVERGENCE_NOTES notes (default 200) plus
 * one large, child-heavy page (a facts fence and a long timeline). Production
 * never installs a fault hook, so the faulted processes are the real
 * `src/cli.ts serve` / `sync` entry points started with the hook-installing
 * preload test/fixtures/convergence-fault-kill.ts (the persistence gate's seam,
 * `fault-points.ts`), which kills, stalls, edits or throws a given SQLSTATE at a named point.
 *
 * Chaos modes (MODES below; a mode master fails is skipped with the PR that turns it on):
 *   (a) client kills and (b) serve kills mid-publish: a kill loop of
 *       GBRAIN_TEST_CONVERGENCE_KILLS (default 6) seeded `kill -9`s at fault points
 *       from the curated sync-reachable list KILL_POINTS, one per change round,
 *       cycling a `--no-delegate` client, a resident serve running a delegated
 *       catch-up, and a serve together with the client delegating to it;
 *   (c) concurrent writers through the coordinator during the kill loop:
 *       `gbrain put` rewrites, `remember` facts on an entity page and a managed
 *       maintenance job (`gbrain extract timeline --source db`);
 *   (c-db) a DB-only competitor: a DB-only write racing a file change of the
 *       same page ends as a named `concurrent_write` hold with both versions
 *       kept; a DB-only write to a page whose file did not change converges;
 *   (d) out-of-band `git mv` / `git rm` of 1% of committed files and deletion
 *       of uncommitted worktree files while a run is stalled mid-manifest;
 *   (e) a deterministic mid-run edit: the `sync:after_freeze` hook edits a
 *       seeded entry after it was frozen and before it is published;
 *   (f) a pooler drop mid-bulk (no new holds);
 *   (g) two concurrent drainers: a `--all` run beside a serve;
 *   (knock-on) one page's failure inside a bulk group cancels none of the others;
 *   (systemic) a trigger raising an unregistered P0001, then a 55000, on every
 *       page write for one run: the run stops with one named blocker, and a
 *       plain sync converges once the trigger is gone.
 *
 * Every scenario then gets a fresh serve (what a supervisor restarts) and at
 * most MAX_RECOVERY_RUNS plain `gbrain sync --no-pull` runs, with no operator
 * step; only exit 0 with outcome `synced` counts. The oracle tests are named by
 * the persistence gate's violation class: disk == database for every page
 * (except the pages a mode's end state names: a ghost, a held page); no request
 * blocks the checkpoint or a root; every non-committed terminal request is
 * superseded or carries a registered code; the cursor reached HEAD; the large
 * page keeps every fence fact; the acknowledged-write ledger (every writer
 * operation that returned success, recorded here independently of the brain)
 * survives or is causally superseded by a later acknowledged write; and
 * `gbrain sync status --json` reports the converged state with every field the
 * operator loop reads present.
 *
 * Every random choice comes from GBRAIN_TEST_CONVERGENCE_SEED (default 6650), and
 * every failure prints the seed, the scenario's modes, its fault plan and a
 * one-line local repro command. GBRAIN_TEST_CONVERGENCE_MODES=a,d,... runs
 * exactly those modes (a skipped mode named there runs anyway). Setup:
 * scripts/persistence/README.md ("Managed-sync convergence gate"). It is
 * skipped unless GBRAIN_TEST_CONVERGENCE=1.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONSUMER_LIVE_MS, CONSUMER_RENEWAL_MS } from '../src/core/persistence/consumer-heartbeat.ts';
import type { FaultPoint } from '../src/core/persistence/fault-points.ts';
import { PUBLICATION_CEILING_DEFAULT_MS, publicationLeaseMs } from '../src/core/persistence/publication-deadline.ts';
import {
  Brain as HarnessBrain, ENTITY, Ledger, SOURCE, STATUS_FIELDS, StdioServe, acknowledged, as, entityText, fastStatusProblems, lastJson,
  noteMarker, noteSlug, noteText, oracleTests, outcome, prng, statusProblems, until, worstStall, type Ack, type Fault, type HarnessKnobs,
} from './helpers/convergence-brain.ts';

const knob = (name: string, fallback: number): number => {
  const raw = process.env[`GBRAIN_TEST_CONVERGENCE_${name}`];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`GBRAIN_TEST_CONVERGENCE_${name} must be a non-negative integer, got '${raw}'.`);
  return value;
};
const SEED = knob('SEED', 6650);
const LATENCY_MS = knob('LATENCY_MS', 50);
const NOTES = Math.max(20, knob('NOTES', 200));
const KILLS = knob('KILLS', 6);
/** Per child process (a sync or a writer call) and per scenario setup; the nightly cell raises both. */
const SYNC_TIMEOUT_MS = knob('SYNC_TIMEOUT_MS', 900_000);
const SCENARIO_TIMEOUT_MS = knob('SCENARIO_TIMEOUT_MS', 3_600_000);
const pooledTarget = process.env.GBRAIN_PGBOUNCER_URL;
const directTarget = process.env.GBRAIN_PGBOUNCER_DIRECT_URL;
const enabled = process.env.GBRAIN_TEST_CONVERGENCE === '1';
if (enabled && !(pooledTarget && directTarget)) {
  throw new Error('GBRAIN_TEST_CONVERGENCE=1 needs GBRAIN_PGBOUNCER_URL (transaction-mode PgBouncer) and GBRAIN_PGBOUNCER_DIRECT_URL (the Postgres behind it).');
}
const PGBOUNCER_CONTAINER = process.env.GBRAIN_TEST_CONVERGENCE_PGBOUNCER_CONTAINER;
const LOG_DIR = process.env.GBRAIN_TEST_CONVERGENCE_LOG_DIR;

/** The chaos modes. `skip` names the PR that turns a mode master fails on; the mode stays written and runs when named in GBRAIN_TEST_CONVERGENCE_MODES. */
const MODES = {
  a: { title: 'client kills', skip: null },
  b: { title: 'serve kills mid-publish', skip: null },
  c: { title: 'concurrent writers: put, remember and a managed maintenance job', skip: null },
  'c-db': { title: 'a DB-only competitor', skip: null },
  d: { title: 'out-of-band git mv/git rm of committed files and deletion of uncommitted files', skip: null },
  e: { title: 'a deterministic mid-run edit after freezeEntry', skip: null },
  f: { title: 'a pooler drop mid-bulk', skip: null },
  g: { title: 'two concurrent drainers: a --all run beside a serve', skip: null },
  lease: { title: 'the drain-lease holder killed with two followers queued behind it', skip: null },
  'knock-on': { title: 'one page failure inside a bulk group', skip: null },
  systemic: { title: 'a systemic database refusal: an unknown P0001 or a 55000 from a trigger on every page write', skip: null },
} as const satisfies Record<string, { title: string; skip: string | null }>;
type Mode = keyof typeof MODES;
const requestedModes = process.env.GBRAIN_TEST_CONVERGENCE_MODES?.split(',').map(mode => mode.trim()).filter(Boolean);
for (const mode of requestedModes ?? []) if (!(mode in MODES)) throw new Error(`GBRAIN_TEST_CONVERGENCE_MODES names unknown mode '${mode}' (known: ${Object.keys(MODES).join(', ')}).`);
const runs = (mode: Mode): boolean => requestedModes ? requestedModes.includes(mode) : MODES[mode].skip === null;

const KNOBS: HarnessKnobs = {
  tag: 'convergence', seed: SEED, latencyMs: LATENCY_MS, syncTimeoutMs: SYNC_TIMEOUT_MS, logDir: LOG_DIR,
  pooledTarget: pooledTarget ?? '', directTarget: directTarget ?? '', summary: `notes ${NOTES}; latency ${LATENCY_MS} ms`,
  repro: modes => `${[`GBRAIN_TEST_CONVERGENCE_SEED=${SEED}`, `GBRAIN_TEST_CONVERGENCE_MODES=${modes.join(',')}`, `GBRAIN_TEST_CONVERGENCE_NOTES=${NOTES}`,
    `GBRAIN_TEST_CONVERGENCE_KILLS=${KILLS}`, `GBRAIN_TEST_CONVERGENCE_LATENCY_MS=${LATENCY_MS}`].join(' ')} GBRAIN_PGBOUNCER_URL="$GBRAIN_PGBOUNCER_URL" GBRAIN_PGBOUNCER_DIRECT_URL="$GBRAIN_PGBOUNCER_DIRECT_URL" bun run test:convergence`,
};
/** One scenario's brain: the shared harness brain (test/helpers/convergence-brain.ts) with this gate's knobs. */
class Brain extends HarnessBrain { constructor(name: string, modes: Mode[]) { super(name, modes, KNOBS); } }

/**
 * The kill loop's fault points: the seams a managed sync import crosses. Its pages are already in Git, so the
 * file-publication pair (`before_publication`/`after_publication`) never fires for it. Per-page seams are counted
 * per submit_job request (nth inside the first 60% of a round); `lane:applied` and `sync:before_group_admission`
 * fire once per bulk group, and a small round may form one group, so they kill at the first; `sync:mid_checkpoint`
 * fires on every cursor save (the first or second); `sync:batch_entries` fires once per pass round, after the level
 * read and before any admission. `sync:passed_over` and `sync:held_settled` need a file that changes after its freeze:
 * their round primes one with an uncommitted edit at `sync:after_freeze`, which the pass passes over once (the level
 * moved) and, when the next round reads the same uncommitted bytes, holds `worktree_dirty` (the hold); the harness
 * commits the edit after the round. A `sync:passed_over` round syncs with `--no-bulk`, which a delegated serve receives
 * too (#8838): a bulk group or admit-ahead window can freeze the primed entry and drop it unadmitted (a group fallback
 * or a kill), and its re-freeze reads the edited bytes, which hold at once instead of passing over. On the single path
 * an entry is admitted right after its freeze, so the edit always reaches publication as a change after admission.
 * Every point here must be one a pass crosses: the cursor engine's `sync:retry_deferred` and `sync:prescreened` are
 * company-source only since #6712 PR 4b, so a non-company kill loop never reaches them.
 */
const KILL_POINTS = [
  { point: 'publication:before_commit', per: 'page' }, { point: 'publication:after_commit', per: 'page' },
  { point: 'consumer:preparing', per: 'page' }, { point: 'lane:applied', per: 'group' },
  { point: 'sync:before_group_admission', per: 'group' }, { point: 'sync:mid_checkpoint', per: 'save' },
  { point: 'sync:held_settled', per: 'held' }, { point: 'sync:passed_over', per: 'deferred' },
  { point: 'sync:batch_entries', per: 'group' },
  // #6712 PR 2 (L5): after the checkpoint committed and the lease was released, before the owed tail runs (the next sync runs it).
  { point: 'sync:tail_started', per: 'group' },
] as const satisfies ReadonlyArray<{ point: FaultPoint; per: 'page' | 'group' | 'save' | 'held' | 'deferred' }>;
/**
 * The longest a sync may sit with no progress after an owner was killed: the
 * window in which a dead owner's heartbeat still reads live, one renewal
 * interval for the survivor to notice, and slack for a slow group. Waiting out
 * a publication lease (`publicationLeaseMs`, 365 s by default) blows it.
 */
const OWNER_KILL_STALL_BOUND_S = (CONSUMER_LIVE_MS + CONSUMER_RENEWAL_MS + 30_000) / 1000;

// ---------------------------------------------------------------- the writers of mode (c)

/** Rewrites notes through the coordinator (`gbrain put`), remembers facts on the entity page and runs the managed timeline maintenance job until `stop`. */
async function runWriters(b: Brain, putTargets: string[], stop: () => boolean): Promise<string[]> {
  const results: string[] = [];
  const put = async () => {
    for (const [k, slug] of putTargets.entries()) {
      if (stop()) break;
      const marker = `Writer rewrite ${k} of ${slug} (${randomUUID().slice(0, 8)})`;
      const content = `---\ntype: concept\ntitle: ${slug.split('/')[1]} rewritten\n---\n\n${marker} through the coordinator.\n`;
      // The start is taken before the first attempt: a retried put may have committed on an earlier attempt.
      const start = performance.now();
      const ok = await acknowledged(b, slug, requestId => b.spawnCli(['put', slug, '--source-id', SOURCE, '--force', '--request-id', requestId, '--wait-ms', '10000'], { stdin: content }), stop);
      const write = { kind: 'put', slug, marker, touches: ['db', 'file'], start } satisfies Omit<Ack, 'ack'>;
      if (ok && 'ack' in ok) b.ledger.record({ ...write, ack: ok.ack });
      if (ok && 'pending' in ok) b.pending.push({ write, requestId: ok.pending });
      results.push(`put ${slug}=${outcome(ok)}`);
      await Bun.sleep(b.between(200, 1500));
    }
  };
  const remember = async () => {
    for (let k = 0; !stop(); k++) {
      const fact = `Alice Example noted item ${k} (${randomUUID().slice(0, 8)}) with acme-example.`;
      const start = performance.now();
      const ok = await acknowledged(b, `remember-${k}`, requestId => b.spawnCli(['call', '--source', SOURCE, 'remember',
        JSON.stringify({ fact, entity: ENTITY, infer_entity: false, provenance: 'convergence harness', request_id: requestId })]), stop);
      const write = { kind: 'remember', slug: ENTITY, marker: fact, touches: 'fact', start } satisfies Omit<Ack, 'ack'>;
      if (ok && 'ack' in ok) b.ledger.record({ ...write, ack: ok.ack });
      if (ok && 'pending' in ok) b.pending.push({ write, requestId: ok.pending });
      results.push(`remember ${k}=${outcome(ok)}`);
      await Bun.sleep(b.between(1000, 4000));
    }
  };
  const maintenance = async () => {
    for (let k = 0; !stop(); k++) {
      const start = performance.now();
      const r = await b.spawnCli(['extract', 'timeline', '--source', 'db']).result;
      b.keepLog(`maintenance-${k}.log`, `exit ${r.code}\n${r.out}\n${r.err}`);
      if (r.code === 0) b.ledger.record({ kind: 'maintenance', slug: '*', marker: null, touches: ['db'], start, ack: performance.now() });
      results.push(`maintenance ${k}=exit ${r.code}`);
      await Bun.sleep(b.between(5000, 10000));
    }
  };
  await Promise.all([put(), remember(), maintenance()]);
  return results;
}

/** A describe that runs when any of its modes runs; skipped (with every skip reason in its title) otherwise. */
function scenario(modes: Mode[], title: string, body: () => void): void {
  const active = enabled && modes.some(runs);
  const reasons = [...new Set(modes.map(m => MODES[m].skip).filter(Boolean))];
  (active ? describe : describe.skip)(`${title} [${modes.map(m => `(${m})`).join(' ')}]${!active && reasons.length ? ` (skipped until ${reasons.join('; ')})` : ''}`, body);
}

// ---------------------------------------------------------------- always-on calibration

// Runs on every invocation, harness enabled or not: the calibration the chaos run's verdicts rest on.
describe('convergence harness calibration (#6650 L0, #6712 PR 0)', () => {
  test('the owner-kill stall bound is below the default publication lease it exists to catch', () => {
    expect(OWNER_KILL_STALL_BOUND_S * 1000).toBeLessThan(publicationLeaseMs(PUBLICATION_CEILING_DEFAULT_MS));
  });
  test('a seed reproduces its fault plan and writer targets', () => {
    const draw = (seed: number) => { const next = prng(seed); return Array.from({ length: 16 }, next); };
    expect(draw(SEED)).toEqual(draw(SEED));
    expect(draw(SEED)).not.toEqual(draw(SEED + 1));
  });
  const converged = (): Record<string, unknown> => ({ source_id: SOURCE, run_id: 'r', cursor: { index: 3, total: 3, pinned_target: 'abc', last_advance_at: null, done: true },
    committed_last_10m: 3, live_job_id: null, rate_pages_per_min: null, eta_seconds: null, holds: [], last_error: null, needs_human: false, resume_argv: ['--source', SOURCE],
    checkpoint_blockers: [], cursors: [], terminal_failures: { status: 'ok', window_days: 7, active_blockers: [], unresolved: { rows: 0 } }, next: null });
  test('the status oracle accepts a converged status, with the finished cursor done or retired', () => {
    expect(statusProblems(converged())).toEqual([]);
    expect(statusProblems({ ...converged(), cursor: null, run_id: null })).toEqual([]);
  });
  test('the fast-status oracle accepts named skipped reads and fails a skipped read that looks read', () => {
    const notRead = { status: 'not_read', fix: { argv: ['gbrain', 'sync', 'status', '--source', SOURCE, '--detail', '--json'] } };
    const fast = { checkpoint_blockers_read: notRead, cursors_read: notRead, terminal_failures_read: notRead };
    expect(fastStatusProblems(fast)).toEqual([]);
    expect(fastStatusProblems({ ...fast, terminal_failures_read: { status: 'read' } })).toEqual(['sync status --json: terminal_failures_read is {"status":"read"}, expected not_read with a --detail fix']);
    expect(fastStatusProblems({ ...fast, cursors_read: undefined })).toHaveLength(1);
  });
  // Forced probe: every field the oracle requires fails it when missing, so a renderer that drops one cannot pass.
  test('the status oracle fails when any required field is missing or not an array', () => {
    for (const field of STATUS_FIELDS) {
      const status = converged(); delete status[field];
      expect(statusProblems(status)).toEqual([`sync status --json: field ${field} missing`]);
    }
    expect(statusProblems({ ...converged(), cursor: { index: 2, total: 3, done: false } })).toContain('sync status --json: cursor not done ({"index":2,"total":3,"done":false})');
    expect(statusProblems({ ...converged(), cursors: {} })).toContain('sync status --json: cursors is not an array');
    expect(statusProblems({ ...converged(), checkpoint_blockers: null })).toContain('sync status --json: checkpoint_blockers is not an array');
    expect(statusProblems({ ...converged(), checkpoint_blockers: [{ request_id: 'x' }] })).toContain('sync status --json: 1 checkpoint blocker(s)');
    expect(statusProblems({ ...converged(), terminal_failures: { status: 'unknown', reason: 'timeout' } })).toContain('sync status --json: terminal_failures.status is unknown');
  });
  test('the ledger accepts the latest acknowledged write and any of two concurrent ones, and flags a lost one', () => {
    const ledger = new Ledger();
    ledger.record({ kind: 'commit', slug: 'n', marker: 'v1', touches: ['db', 'file'], start: 0, ack: 1 });
    ledger.record({ kind: 'put', slug: 'n', marker: 'v2', touches: ['db', 'file'], start: 2, ack: 5 });
    ledger.record({ kind: 'commit', slug: 'n', marker: 'v3', touches: ['db', 'file'], start: 4, ack: 6 });
    ledger.record({ kind: 'remember', slug: 'e', marker: 'fact-1', touches: 'fact', start: 0, ack: 1 });
    const page = (body: string) => new Map([['n', { body }]]);
    expect(ledger.problems(new Map([['n', 'v2']]), page('v3'), new Set(['fact-1']))).toEqual([]);
    expect(ledger.problems(new Map([['n', 'v1']]), page('v1'), new Set(['fact-1']))).toHaveLength(2);
    expect(ledger.problems(new Map([['n', 'v2']]), page('v2'), new Set())).toEqual(['fact on e: lost acknowledged remember "fact-1"']);
  });
  // Forced probe (#6841): a put the brain accepted but had not settled when its writer gave up committed after a later
  // harness commit; dropped from the ledger, its bytes read as the commit's lost write. Its receipt decides it now.
  test('an accepted write that settles after its writer stopped counts by its receipt', async () => {
    const b = new Brain('pending-probe', ['c']);
    const pending = { code: 10, out: '', err: 'Exit 10: accepted, not yet committed.', ms: 0 };
    let attempts = 0;
    const ok = await acknowledged(b, 'notes/n', () => ({ proc: undefined as never, result: Promise.resolve(pending) }), () => attempts++ > 0);
    expect(ok).toEqual({ pending: expect.any(String) });
    const put = { kind: 'put', slug: 'n', marker: 'put-bytes', touches: ['db', 'file'], start: 0 } satisfies Omit<Ack, 'ack'>;
    b.ledger.record({ kind: 'commit', slug: 'n', marker: 'commit-bytes', touches: ['db', 'file'], start: 1, ack: 2 });
    b.pending.push({ write: put, requestId: (ok as { pending: string }).pending });
    const final = (body: string) => b.ledger.problems(new Map([['n', body]]), new Map([['n', { body }]]), new Set());
    await b.settlePending(async () => 'committed');
    expect(final('put-bytes')).toEqual([]);
    expect(final('commit-bytes')).toEqual([]);
    const refused = new Brain('pending-probe', ['c']);
    refused.ledger.record({ kind: 'commit', slug: 'n', marker: 'commit-bytes', touches: ['db', 'file'], start: 1, ack: 2 });
    refused.pending.push({ write: put, requestId: 'r' });
    await refused.settlePending(async () => 'conflict');
    expect(refused.ledger.problems(new Map([['n', 'put-bytes']]), new Map([['n', { body: 'put-bytes' }]]), new Set())).toHaveLength(2);
  });
  // Forced probe: a harness commit leaves another writer's uncommitted bytes alone (a swept commit raced `remember`'s write-through into a concurrent_write hold).
  test('a harness commit commits only the files it wrote', () => {
    const b = new Brain('commit-probe', ['a']);
    b.repo = mkdtempSync(join(tmpdir(), 'gb-conv-probe-'));
    try {
      b.git('init', '-q'); b.git('config', 'user.email', 'example@example.invalid'); b.git('config', 'user.name', 'Example');
      b.commit('fixture', [{ slug: noteSlug(0), content: 'v0\n', marker: 'v0' }, { slug: ENTITY, content: 'e0\n', marker: 'e0' }]);
      writeFileSync(join(b.repo, `${ENTITY}.md`), 'in-flight write-through\n');
      writeFileSync(join(b.repo, 'stray.md'), 'untracked\n');
      b.commit('round one', [{ slug: noteSlug(0), content: 'v1\n', marker: 'v1' }]);
      expect(b.git('show', '--name-only', '--format=', 'HEAD').split('\n')).toEqual([`${noteSlug(0)}.md`]);
      expect(b.git('diff', '--name-only')).toBe(`${ENTITY}.md`);
      expect(b.git('ls-files', '--others', '--exclude-standard')).toBe('stray.md');
    } finally { rmSync(b.repo, { recursive: true, force: true }); }
  });
  test('every mode runs: #6712 PR 2 turned on the last skipped one (f, a pooler drop mid-bulk)', () => {
    for (const mode of ['a', 'b', 'c', 'c-db', 'd', 'e', 'f', 'g', 'lease', 'knock-on', 'systemic'] as const) expect(MODES[mode].skip).toBeNull();
  });
});

// ---------------------------------------------------------------- (a) (b) (c): the kill loop under concurrent writers

scenario(['a', 'b', 'c'], 'managed sync converges after a seeded kill loop of clients and serves under concurrent writers', () => {
  const b = new Brain('kill-loop', (['a', 'b', 'c'] as Mode[]).filter(runs));
  const syncErrs: Record<string, string> = {};
  const ownerKillStalls: Record<string, number> = {};
  const afterClientKill: string[] = [];
  beforeAll(async () => {
    await b.setup(brain => brain.commit('fixture', [
      ...Array.from({ length: NOTES }, (_, i) => ({ slug: noteSlug(i), content: noteText(i, 'Initial'), marker: noteMarker(i, 'Initial') })),
      brain.bigFile(120, 400, 'v0'), { slug: ENTITY, content: entityText, marker: 'Alice Example works with acme-example.' },
    ]));
    // The fault plan, drawn from the seed before anything runs: one kill per round.
    const kinds = [runs('a') && 'client', runs('b') && 'serve', runs('a') && runs('b') && 'serve+client'].filter(Boolean) as Array<'client' | 'serve' | 'serve+client'>;
    const perRound = Math.min(100, Math.max(10, Math.round(NOTES * 0.1)));
    // Victims and fault points cycle from seeded offsets, so six kills reach each victim kind twice and KILL_POINTS.length kills reach every point.
    const offset = b.between(0, 2), pointOffset = b.between(0, KILL_POINTS.length - 1);
    const plan = Array.from({ length: kinds.length ? KILLS : 0 }, (_, k) => {
      const kind = kinds[(k + offset) % kinds.length];
      const { point, per } = KILL_POINTS[(k + pointOffset) % KILL_POINTS.length];
      const nth = per === 'page' ? b.between(2, Math.floor(perRound * 0.6)) : per === 'group' || per === 'held' || per === 'deferred' ? 1 : b.between(1, 2);
      return { round: k + 1, kind, point, nth, operation: per === 'page' || point === 'lane:applied' ? 'submit_job' : undefined, primed: per === 'held' || per === 'deferred' };
    });
    b.plan = plan.map(p => `round ${p.round} ${p.kind} ${p.point} #${p.nth}`);
    const putTargets = runs('c') ? [...new Set(Array.from({ length: 40 }, () => b.between(0, NOTES - 1)))].slice(0, Math.round(NOTES * 0.05)).map(noteSlug) : [];
    b.note(`plan: ${b.plan.join('; ') || 'no kills'}; ${perRound} notes per round; writers ${runs('c') ? `put ${putTargets.length} notes, remember, maintenance` : 'off'}`);
    let chaosDone = false;
    const writers: Promise<string[]> = runs('c') ? runWriters(b, putTargets, () => chaosDone) : Promise.resolve([]);
    const chaosStarted = performance.now();
    for (const p of plan) {
      const started = performance.now();
      const tag = `round-${p.round}`;
      const first = (p.round * perRound) % NOTES;
      const indexes = Array.from({ length: perRound }, (_, i) => (first + i) % NOTES);
      const edited = p.primed ? indexes[Math.floor(perRound / 2)]! : null;
      const fault: Fault = { point: p.point, nth: p.nth, marker: b.marker(tag), operation: p.operation,
        ...(edited !== null ? { prime: { point: 'sync:after_freeze', nth: 1, path: `${noteSlug(edited)}.md`,
          edit: { file: join(b.repo, `${noteSlug(edited)}.md`), content: noteText(edited, `Round ${p.round} edit`) } } } : {}) };
      b.writeNotes(indexes, `Round ${p.round}`, `round ${p.round}`, p.round % 3 === 1 ? [b.bigFile(120 + 20 * p.round, 400 + 40 * p.round, `v${p.round}`)] : []);
      const single = p.point === 'sync:passed_over' ? ['--no-bulk'] : [];
      let line: string;
      if (p.kind === 'client') {
        const r = await b.sync(['--no-pull', '--no-delegate', '--json', ...single], fault).result;
        syncErrs[tag] = r.err; b.keepLog(`${tag}-client.log`, `${r.out}\n${r.err}`);
        line = `client exit ${r.code} in ${(r.ms / 1000).toFixed(1)}s`;
      } else {
        const serve = new StdioServe(b, fault);
        await serve.start();
        const client = b.sync(['--no-pull', '--json', ...single]);
        await Promise.race([serve.exited, client.result]);
        if (p.kind === 'serve+client' && !serve.alive) { client.proc.kill('SIGKILL'); b.killedPids.add(client.proc.pid); }
        const r = await client.result;
        syncErrs[tag] = r.err; ownerKillStalls[`${tag} (${p.kind})`] = worstStall(r.err);
        b.keepLog(`${tag}-client.log`, `${r.out}\n${r.err}`); b.keepLog(`${tag}-serve.log`, serve.stderr);
        line = `serve ${serve.alive ? 'survived' : 'killed'}; client exit ${r.code}${client.proc.signalCode ? ` (${client.proc.signalCode})` : ''} in ${(r.ms / 1000).toFixed(1)}s, worst stall ${worstStall(r.err)}s`;
        if (plan[p.round - 2]?.kind === 'client') afterClientKill.push(tag);
        await serve.stop();
      }
      // A prime that never fired (the round's sync never froze the entry) left nothing to commit: that is a fault that did
      // not fire, named by the oracle with the rest of the run's evidence, not a harness crash that discards it.
      if (edited !== null && !b.git('status', '--porcelain', '--', `${noteSlug(edited)}.md`)) b.fired[`round ${p.round} prime sync:after_freeze ${noteSlug(edited)}.md`] = null;
      else if (edited !== null) {
        const editStart = performance.now();
        b.git('add', '--', `${noteSlug(edited)}.md`); b.git('commit', '-qm', `round ${p.round}: the editor commits`, '--', `${noteSlug(edited)}.md`);
        b.ledger.record({ kind: 'commit', slug: noteSlug(edited), marker: noteMarker(edited, `Round ${p.round} edit`), touches: ['db', 'file'], start: editStart, ack: performance.now() });
      }
      const fired = b.recordFault(tag, `round ${p.round} ${p.kind} ${p.point} #${p.nth}`);
      b.note(`round ${p.round} (${p.kind}): ${fired ? `fault fired ${fired}` : 'no fault fired'}; ${line}`);
      b.elapsed[`${tag}_ms`] = performance.now() - started;
    }
    chaosDone = true;
    const results = await writers;
    b.elapsed.chaos_ms = performance.now() - chaosStarted;
    b.note(`writers: ${results.join(' ')}`);
    await b.recover();
    await b.settlePending();
    for (const [i, run] of b.recoveryRuns.entries()) { syncErrs[`recovery ${i + 1}`] = run.err; ownerKillStalls[`recovery run ${i + 1}`] = worstStall(run.err); }
  }, SCENARIO_TIMEOUT_MS);
  afterAll(() => b.teardown(), 120_000);

  oracleTests(b, () => ({}));
  test(as('wedge', "a killed client's stale heartbeat never keeps ownership from a live serve"), () => {
    const deadOwners = Object.entries(syncErrs).flatMap(([run, err]) => [...err.matchAll(/the live write owner on this host is a (\w+) process \(PID (\d+)\)/g)]
      .filter(m => b.killedPids.has(Number(m[2]))).map(m => `${run}: ${m[0]}`));
    const notDelegated = afterClientKill.filter(tag => !/running the managed catch-up inside it as this CLI's writer/.test(syncErrs[tag] ?? ''))
      .map(tag => `${tag}: the client after a client kill did not delegate to the live serve`);
    b.verdict([...deadOwners, ...notDelegated]);
  });
  test(as('wedge', 'recovery after an owner kill does not wait out the publication lease'), () => {
    b.note(`worst stall after an owner kill (bound ${OWNER_KILL_STALL_BOUND_S}s): ${Object.entries(ownerKillStalls).map(([k, v]) => `${k} ${v}s`).join(', ')}`);
    b.verdict(Object.entries(ownerKillStalls).filter(([, stall]) => stall > OWNER_KILL_STALL_BOUND_S).map(([k, v]) => `${k} stalled ${v}s`));
  });
});

// ---------------------------------------------------------------- (c-db): a DB-only competitor

scenario(['c-db'], 'a DB-only write racing a file change ends as a named hold with both versions kept', () => {
  const b = new Brain('db-only', ['c-db']);
  const notes = 20;
  const raced = noteSlug(3), quiet = noteSlug(11);
  beforeAll(async () => {
    // A DB-only write needs write-through off (the #6194 contract): the coordinator then publishes page writes to the database only.
    await b.setup(brain => brain.writeNotes(Array.from({ length: notes }, (_, i) => i), 'Initial', 'fixture'), { 'sync.write_through': 'false' });
    const indexes = Array.from({ length: 8 }, (_, i) => i);
    b.writeNotes(indexes, 'Git edit', 'git edit');
    const tag = 'stall', release = join(b.home, 'release-stall');
    b.plan = [`stall at sync:after_freeze for ${raced}.md; DB-only put of ${raced} and ${quiet}`];
    const run = b.sync(['--no-pull', '--no-delegate', '--json'], { point: 'sync:after_freeze', nth: 1, path: `${raced}.md`, marker: b.marker(tag), action: 'stall', release });
    await until(() => existsSync(b.marker(tag)), 'the run to freeze the raced entry', SYNC_TIMEOUT_MS);
    for (const slug of [raced, quiet]) {
      const marker = `Database-only edit of ${slug} (${randomUUID().slice(0, 8)})`;
      const start = performance.now();
      const r = await b.spawnCli(['put', slug, '--source-id', SOURCE, '--force', '--wait-ms', '30000'], { stdin: `---\ntype: concept\ntitle: ${slug} database edit\n---\n\n${marker}.\n` }).result;
      b.keepLog(`db-only-${slug.replace('/', '_')}.log`, `exit ${r.code}\n${r.out}\n${r.err}`);
      if (r.code !== 0) throw new Error(`the DB-only put of ${slug} exited ${r.code}: ${r.err}\n${b.context()}`);
      b.ledger.record({ kind: 'db_only', slug, marker, touches: ['db'], start, ack: performance.now() });
    }
    writeFileSync(release, '');
    const r = await run.result;
    b.keepLog('raced-run.log', `${r.out}\n${r.err}`);
    b.recordFault(tag, b.plan[0]);
    b.note(`raced run: exit ${r.code} in ${(r.ms / 1000).toFixed(1)}s`);
    await b.recover();
  }, SCENARIO_TIMEOUT_MS);
  afterAll(() => b.teardown(), 120_000);
  oracleTests(b, () => ({ exclude: new Set([raced, quiet]), bigPage: false,
    status: { holds: [{ code: 'concurrent_write', path: `${raced}.md` }], needsHuman: true } }));
  test(as('lost_write', 'the held file keeps its committed bytes and the page keeps the DB-only write'), () => {
    const disk = b.diskPages();
    b.verdict([
      ...(disk.get(raced)?.includes(noteMarker(3, 'Git edit')) ? [] : [`${raced}: the file lost its committed Git edit`]),
      ...(disk.get(quiet)?.includes(noteMarker(11, 'Initial')) ? [] : [`${quiet}: the file changed although only the database was written`]),
    ]);
  });
});

// ---------------------------------------------------------------- (d): out-of-band git mv / git rm and uncommitted deletions

scenario(['d'], 'committed git mv/git rm mid-run converge; an uncommitted deletion is a ghost with the repair ghost-pages exit', () => {
  const b = new Brain('git-moves', ['d']);
  const notes = Math.min(NOTES, 200);
  const share = Math.max(2, Math.round(notes * 0.01));
  const moved: string[] = [], removed: string[] = [], ghosts: string[] = [];
  let ghostScan: Record<string, unknown> | null = null;
  beforeAll(async () => {
    await b.setup(brain => brain.writeNotes(Array.from({ length: notes }, (_, i) => i), 'Initial', 'fixture'));
    const indexes = Array.from({ length: 40 }, (_, i) => i);
    b.writeNotes(indexes, 'Round one', 'round one');
    const others = Array.from({ length: notes - 40 }, (_, i) => i + 40).sort(() => b.rand() - 0.5);
    moved.push(...others.slice(0, share).map(noteSlug)); removed.push(...others.slice(share, 2 * share).map(noteSlug)); ghosts.push(...others.slice(2 * share, 3 * share).map(noteSlug));
    const tag = 'stall', release = join(b.home, 'release-stall');
    b.plan = [`stall at sync:after_freeze #5; git mv ${moved.join(',')}; git rm ${removed.join(',')}; unlink (uncommitted) ${ghosts.join(',')}`];
    const run = b.sync(['--no-pull', '--no-delegate', '--json'], { point: 'sync:after_freeze', nth: 5, marker: b.marker(tag), action: 'stall', release });
    await until(() => existsSync(b.marker(tag)), 'the run to freeze its fifth entry', SYNC_TIMEOUT_MS);
    const start = performance.now();
    mkdirSync(join(b.repo, 'moved'), { recursive: true });
    for (const slug of moved) b.git('mv', `${slug}.md`, `moved/${slug.split('/')[1]}.md`);
    for (const slug of removed) b.git('rm', '-q', `${slug}.md`);
    b.git('commit', '-qm', 'out-of-band moves and removals');
    for (const slug of ghosts) rmSync(join(b.repo, `${slug}.md`));
    const ack = performance.now();
    for (const slug of moved) {
      const i = Number(slug.split('-')[1]);
      b.ledger.record({ kind: 'git_mv', slug, marker: null, touches: ['db', 'file'], start, ack });
      b.ledger.record({ kind: 'git_mv', slug: `moved/${slug.split('/')[1]}`, marker: noteMarker(i, 'Initial'), touches: ['db', 'file'], start, ack });
    }
    for (const slug of removed) b.ledger.record({ kind: 'git_rm', slug, marker: null, touches: ['db', 'file'], start, ack });
    for (const slug of ghosts) b.ledger.record({ kind: 'unlink', slug, marker: null, touches: ['file'], start, ack });
    writeFileSync(release, '');
    const r = await run.result;
    b.keepLog('stalled-run.log', `${r.out}\n${r.err}`);
    b.recordFault(tag, b.plan[0]);
    b.note(`stalled run: exit ${r.code} in ${(r.ms / 1000).toFixed(1)}s`);
    await b.recover();
    const scan = await b.spawnCli(['pages', 'ghosts', '--source', SOURCE, '--json']).result;
    b.keepLog('ghosts.json', `${scan.out}\n${scan.err}`);
    ghostScan = lastJson(scan.out);
  }, SCENARIO_TIMEOUT_MS);
  afterAll(() => b.teardown(), 120_000);
  oracleTests(b, () => ({ exclude: new Set(ghosts), bigPage: false }));
  test(as('projection_drift', 'each uncommitted deletion is reported as a ghost page whose exit is repair ghost-pages'), () => {
    const listed = ((ghostScan?.ghosts ?? []) as Array<{ slug: string }>).map(g => g.slug).sort();
    const next = JSON.stringify(ghostScan?.next ?? []);
    b.verdict([
      ...(JSON.stringify(listed) === JSON.stringify([...ghosts].sort()) ? [] : [`pages ghosts lists [${listed.join(', ')}], expected [${[...ghosts].sort().join(', ')}]`]),
      ...(next.includes(`gbrain repair ghost-pages --source ${SOURCE}`) ? [] : [`pages ghosts next does not name gbrain repair ghost-pages: ${next}`]),
    ]);
  });
});

// ---------------------------------------------------------------- (e): a deterministic mid-run edit

scenario(['e'], 'an edit after freezeEntry is held worktree_dirty, then converges strictly once committed', () => {
  const b = new Brain('mid-run-edit', ['e']);
  const notes = Math.min(NOTES, 60);
  const target = 7;
  let raced: Record<string, unknown> | null = null;
  let heldAfterRun: Array<{ code: string; path: string }> = [];
  beforeAll(async () => {
    await b.setup(brain => brain.writeNotes(Array.from({ length: notes }, (_, i) => i), 'Initial', 'fixture'));
    b.writeNotes(Array.from({ length: 20 }, (_, i) => i), 'Round one', 'round one');
    const tag = 'edit', file = join(b.repo, `${noteSlug(target)}.md`);
    b.plan = [`edit ${noteSlug(target)}.md at sync:after_freeze #1 (uncommitted)`];
    const start = performance.now();
    const r = await b.sync(['--no-pull', '--no-delegate', '--json'], { point: 'sync:after_freeze', nth: 1, path: `${noteSlug(target)}.md`, marker: b.marker(tag), action: 'edit',
      edit: { file, content: noteText(target, 'Uncommitted edit') } }).result;
    b.keepLog('edited-run.log', `${r.out}\n${r.err}`);
    b.recordFault(tag, b.plan[0]);
    raced = lastJson(r.out);
    heldAfterRun = ((await b.status())?.holds ?? []) as Array<{ code: string; path: string }>;
    b.note(`edited run: exit ${r.code}; holds ${JSON.stringify(heldAfterRun.map(h => `${h.code}:${h.path}`))}`);
    b.git('add', '--', `${noteSlug(target)}.md`); b.git('commit', '-qm', 'the editor commits', '--', `${noteSlug(target)}.md`);
    b.ledger.record({ kind: 'commit', slug: noteSlug(target), marker: noteMarker(target, 'Uncommitted edit'), touches: ['db', 'file'], start, ack: performance.now() });
    await b.recover();
  }, SCENARIO_TIMEOUT_MS);
  afterAll(() => b.teardown(), 120_000);
  test(as('lost_write', 'the run that met the uncommitted edit names worktree_dirty for it'), () => {
    const path = `${noteSlug(target)}.md`;
    const envelopeNames = JSON.stringify(raced ?? {}).includes('worktree_dirty');
    b.verdict(heldAfterRun.some(h => h.code === 'worktree_dirty' && h.path === path) && envelopeNames ? []
      : [`expected a worktree_dirty hold on ${path} in the run's receipt and status; status holds ${JSON.stringify(heldAfterRun)}, receipt ${JSON.stringify(raced).slice(0, 400)}`]);
  });
  oracleTests(b, () => ({ bigPage: false }));
});

// ---------------------------------------------------------------- (f): a pooler drop mid-bulk

scenario(['f'], 'a pooler drop mid-bulk leaves no new hold and converges', () => {
  const b = new Brain('pooler-drop', ['f']);
  const notes = Math.min(NOTES, 200);
  let holdsBefore = 0, holdsAfter = 0, stall = 0;
  beforeAll(async () => {
    await b.setup(brain => brain.writeNotes(Array.from({ length: notes }, (_, i) => i), 'Initial', 'fixture'));
    b.writeNotes(Array.from({ length: Math.min(notes, 120) }, (_, i) => i), 'Round one', 'round one');
    holdsBefore = ((await b.status())?.holds as unknown[] | undefined)?.length ?? 0;
    const at = await b.now();
    const how = PGBOUNCER_CONTAINER ? `docker restart -t 0 ${PGBOUNCER_CONTAINER}` : 'drop every pooled connection at the proxy';
    b.plan = [`${how} after 20 committed pages`];
    const run = b.sync(['--no-pull', '--no-delegate', '--json']);
    const dropped = until(async () => (await b.committedSince(at)) >= 20, 'twenty committed pages', SYNC_TIMEOUT_MS).then(() => {
      if (PGBOUNCER_CONTAINER) execFileSync('docker', ['restart', '-t', '0', PGBOUNCER_CONTAINER], { stdio: 'ignore' });
      else b.note(`dropped ${b.pooledProxy!.drop()} pooled connections`);
      return 'dropped';
    });
    const r = await run.result;
    b.fired[b.plan[0]] = await dropped.catch(() => null);
    b.keepLog('dropped-run.log', `${r.out}\n${r.err}`);
    stall = worstStall(r.err);
    b.note(`dropped run: exit ${r.code} in ${(r.ms / 1000).toFixed(1)}s, worst stall ${stall}s`);
    await b.recover();
    holdsAfter = ((await b.status())?.holds as unknown[] | undefined)?.length ?? 0;
  }, SCENARIO_TIMEOUT_MS);
  afterAll(() => b.teardown(), 120_000);
  test(as('wedge', 'the pooler drop created no hold'), () => b.verdict(holdsAfter > holdsBefore ? [`${holdsAfter - holdsBefore} new hold(s) after the pooler drop`] : []));
  // A dropped pooled connection is an owner losing its session: the drain resumes within the owner-kill bound, not a publication lease.
  test(as('wedge', `the run resumed within ${OWNER_KILL_STALL_BOUND_S}s of the pooler drop`), () =>
    b.verdict(stall > OWNER_KILL_STALL_BOUND_S ? [`the dropped run stalled ${stall}s on one step`] : []));
  oracleTests(b, () => ({ bigPage: false }));
});

// ---------------------------------------------------------------- (g): two concurrent drainers

scenario(['g'], 'a --all run beside a serve draining the same source converges', () => {
  const b = new Brain('two-drainers', ['g']);
  const notes = Math.min(NOTES, 200);
  beforeAll(async () => {
    await b.setup(brain => brain.writeNotes(Array.from({ length: notes }, (_, i) => i), 'Initial', 'fixture'));
    b.writeNotes(Array.from({ length: Math.min(notes, 120) }, (_, i) => i), 'Round one', 'round one');
    b.plan = ['a delegated sync drains in the serve while sync --all --no-delegate drains beside it'];
    const serve = new StdioServe(b);
    await serve.start();
    const [delegated, all] = await Promise.all([b.sync(['--no-pull', '--json']).result,
      b.spawnCli(['sync', '--all', '--no-pull', '--no-delegate', '--json']).result]);
    b.keepLog('delegated.log', `${delegated.out}\n${delegated.err}`); b.keepLog('all.log', `${all.out}\n${all.err}`);
    b.note(`delegated sync exit ${delegated.code}; --all exit ${all.code}`);
    await serve.stop();
    await b.recover();
  }, SCENARIO_TIMEOUT_MS);
  afterAll(() => b.teardown(), 120_000);
  oracleTests(b, () => ({ bigPage: false }));
});

// ---------------------------------------------------------------- (lease): the drain-lease holder dies with followers queued

scenario(['lease'], 'a killed drain-lease holder is taken over by a queued follower and the source converges', () => {
  const b = new Brain('lease-takeover', ['lease']);
  const notes = Math.min(NOTES, 200);
  const followers: Array<{ code: number; envelope: Record<string, unknown> | null; followed: boolean }> = [];
  beforeAll(async () => {
    await b.setup(brain => brain.writeNotes(Array.from({ length: notes }, (_, i) => i), 'Initial', 'fixture'));
    b.writeNotes(Array.from({ length: Math.min(notes, 120) }, (_, i) => i), 'Round one', 'round one');
    const tag = 'leader', release = join(b.home, 'release-leader');
    b.plan = ['leader stalls at sync:lease_acquired #1; two --no-delegate followers queue behind it; the leader is SIGKILLed'];
    const leader = b.sync(['--no-pull', '--no-delegate', '--json'], { point: 'sync:lease_acquired', nth: 1, marker: b.marker(tag), action: 'stall', release });
    await until(() => existsSync(b.marker(tag)), 'the leader to take the drain lease', SYNC_TIMEOUT_MS);
    const queued = [0, 1].map(() => b.sync(['--no-pull', '--no-delegate', '--json', '--timeout', '10m']));
    // Both followers must be following the live leader before it dies (they print the holder once they see it).
    await Bun.sleep(5_000);
    leader.proc.kill('SIGKILL'); b.killedPids.add(leader.proc.pid);
    const killed = await leader.result;
    b.keepLog('leader.log', `${killed.out}\n${killed.err}`);
    b.recordFault(tag, b.plan[0]);
    for (const [i, run] of queued.entries()) {
      const r = await run.result;
      b.keepLog(`follower-${i + 1}.log`, `${r.out}\n${r.err}`);
      followers.push({ code: r.code, envelope: lastJson(r.out), followed: r.err.includes('following it until it finishes') });
      b.note(`follower ${i + 1}: exit ${r.code} in ${(r.ms / 1000).toFixed(1)}s outcome=${String(lastJson(r.out)?.outcome ?? 'none')}`);
    }
    await b.recover();
  }, SCENARIO_TIMEOUT_MS);
  afterAll(() => b.teardown(), 120_000);
  test(as('wedge', 'a follower takes over the dead holder inside the lease TTL; no follower ends blocked'), () => b.verdict([
    ...(followers.some(f => f.followed) ? [] : ['no follower reported following the live leader']),
    ...(followers.some(f => f.code === 0 && f.envelope?.outcome === 'synced') ? [] : [`no follower finished the source: ${JSON.stringify(followers.map(f => [f.code, f.envelope?.outcome]))}`]),
    ...followers.filter(f => f.envelope?.outcome === 'blocked').map(f => `a follower ended blocked: ${JSON.stringify(f.envelope?.next ?? f.envelope).slice(0, 400)}`),
  ]));
  oracleTests(b, () => ({ bigPage: false }));
});

// ---------------------------------------------------------------- (systemic): a refusal on every page write

for (const sqlstate of ['P0001', '55000'] as const) {
  scenario(['systemic'], `a systemic ${sqlstate} refusal stops the run with a named blocker and converges once lifted`, () => {
    const b = new Brain(`systemic-${sqlstate}`, ['systemic']);
    const notes = Math.min(NOTES, 200);
    let refused: { code: number; envelope: Record<string, unknown> | null; terminal: number } | null = null;
    beforeAll(async () => {
      await b.setup(brain => brain.writeNotes(Array.from({ length: notes }, (_, i) => i), 'Initial', 'fixture'));
      b.writeNotes(Array.from({ length: Math.min(notes, 40) }, (_, i) => i), 'Round one', 'round one');
      b.plan = [`trigger on pages raising SQLSTATE ${sqlstate} (an unregistered raiser) for one sync run, then dropped`];
      await b.engine!.executeRaw(`CREATE FUNCTION convergence_systemic_refusal() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION USING ERRCODE = '${sqlstate}', MESSAGE = 'convergence harness: systemic refusal'; END $$`);
      await b.engine!.executeRaw('CREATE TRIGGER convergence_systemic_refusal BEFORE INSERT OR UPDATE ON pages FOR EACH ROW EXECUTE FUNCTION convergence_systemic_refusal()');
      b.fired[b.plan[0]] = 'installed';
      const at = await b.now();
      const r = await b.sync(['--no-pull', '--no-delegate', '--json']).result;
      b.keepLog('refused-run.log', `${r.out}\n${r.err}`);
      await b.engine!.executeRaw('DROP TRIGGER convergence_systemic_refusal ON pages; DROP FUNCTION convergence_systemic_refusal()');
      const terminal = (await b.engine!.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM persistence_requests WHERE operation='submit_job'
        AND created_at > $1::timestamptz AND state IN ('failed','conflict','cancelled')`, [at]))[0].n;
      refused = { code: r.code, envelope: lastJson(r.out), terminal };
      b.note(`refused run: exit ${r.code} in ${(r.ms / 1000).toFixed(1)}s outcome=${String(refused.envelope?.outcome ?? refused.envelope?.sync_status ?? 'none')}; ${terminal} terminal non-committed request(s)`);
      await b.recover();
    }, SCENARIO_TIMEOUT_MS);
    afterAll(() => b.teardown(), 120_000);
    test(as('wedge', 'the refused run does not report success and its receipt names the SQLSTATE'), () => b.verdict([
      ...(refused?.code !== 0 && refused?.envelope?.outcome !== 'synced' ? [] : [`the refused run reported success (exit ${refused?.code}, outcome ${String(refused?.envelope?.outcome)})`]),
      ...(JSON.stringify(refused?.envelope ?? {}).includes(sqlstate) ? [] : [`the refused run's receipt does not name ${sqlstate}: ${JSON.stringify(refused?.envelope).slice(0, 400)}`]),
    ]));
    oracleTests(b, () => ({ bigPage: false }));
  });
}

// ---------------------------------------------------------------- (knock-on): one page, one fate

scenario(['knock-on'], 'one failed page inside a bulk group cancels no other page of the run', () => {
  const b = new Brain('knock-on', ['knock-on']);
  const notes = Math.min(NOTES, 200);
  const refused = noteSlug(5);
  let cancelled: string[] = [];
  beforeAll(async () => {
    await b.setup(brain => brain.writeNotes(Array.from({ length: notes }, (_, i) => i), 'Initial', 'fixture'));
    const changed = Array.from({ length: Math.min(notes, 80) }, (_, i) => i);
    b.plan = ['throw SQLSTATE P0001 once at publication:before_commit #5 (submit_job)',
      `trigger on pages raising SQLSTATE P0001 for ${refused} only, for one sync run, then dropped`];
    const at = await b.now();
    b.writeNotes(changed, 'Round one', 'round one');
    const tag = 'throw';
    const r = await b.sync(['--no-pull', '--no-delegate', '--json'], { point: 'publication:before_commit', nth: 5, operation: 'submit_job', marker: b.marker(tag), action: 'throw', sqlstate: 'P0001' }).result;
    b.keepLog('failed-run.log', `${r.out}\n${r.err}`);
    const fired = b.recordFault(tag, b.plan[0]);
    const failed = fired ? (JSON.parse(fired) as { requestId?: string }).requestId : undefined;
    b.note(`one-shot failure run: exit ${r.code}`);
    b.writeNotes(changed, 'Round two', 'round two');
    await b.engine!.executeRaw(`CREATE FUNCTION convergence_page_refusal() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.slug = '${refused}' THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'convergence harness: page refusal'; END IF; RETURN NEW; END $$`);
    await b.engine!.executeRaw('CREATE TRIGGER convergence_page_refusal BEFORE INSERT OR UPDATE ON pages FOR EACH ROW EXECUTE FUNCTION convergence_page_refusal()');
    b.fired[b.plan[1]] = 'installed';
    const refusedRun = await b.sync(['--no-pull', '--no-delegate', '--json']).result;
    b.keepLog('refused-page-run.log', `${refusedRun.out}\n${refusedRun.err}`);
    await b.engine!.executeRaw('DROP TRIGGER convergence_page_refusal ON pages; DROP FUNCTION convergence_page_refusal()');
    cancelled = (await b.engine!.executeRaw<{ request_id: string; slug: string; error_code: string | null }>(
      `SELECT request_id::text, slug, error_code FROM persistence_requests WHERE operation='submit_job' AND created_at > $1::timestamptz AND state='cancelled'
        AND request_id::text <> $2 AND slug <> $3`, [at, failed ?? '', refused])).map(row => `${row.slug} (${row.error_code})`);
    b.note(`refused-page run: exit ${refusedRun.code}; ${cancelled.length} other request(s) cancelled`);
    await b.recover();
  }, SCENARIO_TIMEOUT_MS);
  afterAll(() => b.teardown(), 120_000);
  test(as('wedge', 'the failed page cancelled no other page of its run'), () => b.verdict(cancelled.map(c => `cancelled as a knock-on: ${c}`)));
  oracleTests(b, () => ({ bigPage: false }));
});
