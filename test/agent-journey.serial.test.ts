/**
 * Lane H1a (Tier 1): the deterministic keyless agent journey, end to end.
 *
 * An agent with no provider keys, no TTY, and stdin either closed
 * (`</dev/null`) or an open pipe that never writes, drives the real CLI and
 * real stdio MCP sessions under hard timeouts:
 *
 *   init --pglite --no-embedding --json   one document carrying the first-run decision bundle
 *   doctor --json                          day zero: 0 WARN/FAIL, health >= 90, capped_by
 *   import <dir> --no-embed --json         3 pages, one document
 *   doctor --remediate (no authorization)  exit 3, consent payload, nothing mutated
 *                                          (also on a pending-migration brain: schema version unchanged)
 *   the user agrees → the fix argv verbatim → remediation runs, migrations apply after consent
 *   serve --surface verbs                  remember/recall, degraded notice as a separate prefixed
 *                                          block + _meta.gbrain_notices, caller mistake → one-block
 *                                          envelope whose fix runs; a second serve on the locked brain
 *                                          completes the handshake in status-only mode naming the owner
 *   serve --surface full                   search with the degraded notice, list_pages caller mistake → fix
 *   doctor --json                          health >= 90 with capped_by
 *
 * Machine timings (init, initialize, first remember, first recall) are printed
 * and written to .context/agent-journey-timings.json for Lane I.
 *
 * Existing lane tests cover the pieces in isolation (cli-json-guard D2 init,
 * doctor-day-zero E2, doctor-remediate-consent C1, observational-startup A4,
 * mcp-notice-channels F3, serve-status-mode F4); this file proves they compose
 * into one working journey through the real binary. Wire goldens:
 * test/fixtures/agent-contract/v1/journey/ (transcripts in AGENT_OPERATOR_v1.md).
 *
 * Serial: real subprocesses and PGLite datastores in temp homes.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { LATEST_VERSION, hasPendingMigrations } from '../src/core/migrate.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { snapshotBrain, type BrainSnapshot } from './helpers/fresh-brain-snapshot.ts';
import {
  REPO, body, call, expectOneBlockError, gb, journeyGolden, mcp, noticeBlocks, oneDocument, NOTICE_PREFIX,
  type McpSession, type StdinMode,
} from './helpers/agent-journey.ts';

const MARKER = 'quokka-journey-marker';
const PAGES = 3;
const timings: Record<string, number> = {};

function brainPath(home: string): string { return join(home, '.gbrain', 'brain.pglite'); }

async function withBrain<T>(home: string, fn: (engine: PGLiteEngine) => Promise<T>): Promise<T> {
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: brainPath(home) });
  try { return await fn(engine); } finally { await engine.disconnect(); }
}

/** Brain state an unauthorized run must leave alone. The agent-contract event log (E11) and audit trail record the refusal by design. */
async function brainState(home: string): Promise<BrainSnapshot> {
  const snap = await snapshotBrain(home, brainPath(home));
  for (const key of Object.keys(snap.files)) {
    if (/(^|\/)\.gbrain\/(agent-contract|audit)(\/|$)/.test(key)) delete snap.files[key];
  }
  return snap;
}

function writeNotes(home: string): string {
  const dir = join(home, 'notes');
  mkdirSync(dir, { recursive: true });
  for (let i = 1; i <= PAGES; i++) {
    writeFileSync(join(dir, `journey-note-${i}.md`), `---\ntitle: Journey note ${i}\n---\n\n# Journey note ${i}\n\nThe ${MARKER} ${i} lives in note ${i}.\n`);
  }
  return dir;
}

/** A repairable finding a real legacy brain carries: a timeline row that exists only in the database. */
async function seedRepairableFinding(home: string): Promise<void> {
  await withBrain(home, engine => engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(
    `INSERT INTO timeline_entries(page_id,date,source,summary,detail)
       SELECT id,'2026-07-01','legacy','A database-only event','' FROM pages WHERE source_id='default' AND slug='journey-note-1'`),
  TEST_WRITE_ATTRIBUTION)));
}

interface DoctorReport { status: string; health_score: number; capped_by?: string[]; checks: Array<{ name: string; status: string; message: string; fix?: { argv?: string[]; next?: string }; fix_unavailable_reason?: string }> }

function expectHealthy(report: DoctorReport, label: string): void {
  expect(report.health_score, `${label}: health_score`).toBeGreaterThanOrEqual(90);
  expect(report.capped_by, `${label}: capped_by names the keyless choice`).toEqual(['embeddings_disabled']);
  const fails = report.checks.filter(c => c.status === 'fail').map(c => `${c.name}: ${c.message}`);
  expect(fails, `${label}: no FAIL`).toEqual([]);
  const unfixable = report.checks.filter(c => c.status === 'warn' && !c.fix?.argv).map(c => `${c.name}: ${c.message} (${c.fix_unavailable_reason})`);
  expect(unfixable, `${label}: every WARN carries an executable fix`).toEqual([]);
}

for (const stdin of ['devnull', 'silent'] as StdinMode[]) {
  describe(`H1a keyless CLI journey, stdin ${stdin === 'devnull' ? '</dev/null' : 'an open silent pipe'}`, () => {
    let home = '';
    const cli = (args: string[], timeoutMs = 120_000) => gb(home, args, { stdin, timeoutMs });

    beforeAll(() => { home = mkdtempSync(join(tmpdir(), `gbrain-journey-${stdin}-`)); });
    afterAll(() => { rmSync(home, { recursive: true, force: true }); });

    test('init --pglite --no-embedding --json: one document with the first-run decision bundle', async () => {
      const r = await cli(['init', '--pglite', '--no-embedding', '--json']);
      expect(r.exitCode, r.stderr).toBe(0);
      if (stdin === 'devnull') timings.init_ms = r.ms;
      const doc = oneDocument(r, 'init --json');
      expect(doc).toMatchObject({ status: 'success', engine: 'pglite', contract_version: 1 });
      const bundles = (doc.notices as Array<Record<string, any>>).filter(n => n.code === 'first_run_decisions');
      expect(bundles).toHaveLength(1);
      const bundle = bundles[0]!;
      expect(bundle).toMatchObject({ kind: 'ask', contract_version: 1 });
      expect(bundle.user_message).toContain("Reply 'defaults'");
      expect(bundle.decisions.map((d: { id: string }) => d.id)).toEqual(expect.arrayContaining(['search_mode', 'harness_wiring']));
      for (const d of bundle.decisions) {
        expect(d.options.map((o: { id: string }) => o.id), `${d.id}: default is an option`).toContain(d.default);
        expect(d.default_reason, `${d.id}: default_reason`).toBeTruthy();
      }
      // No fabricated user fact: the brain holds no pages and no facts after init.
      await withBrain(home, async engine => {
        expect((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages'))[0]!.n).toBe(0);
        expect((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM facts'))[0]!.n).toBe(0);
      });
      if (stdin === 'devnull') journeyGolden('init-first-run.json', doc, { home });
    }, 150_000);

    test('day-zero doctor --json: 0 WARN, 0 FAIL, health >= 90, capped_by', async () => {
      const r = await cli(['doctor', '--json']);
      expect(r.exitCode, r.stderr).toBe(0);
      const report = oneDocument(r, 'doctor --json') as DoctorReport;
      expect(report.checks.filter(c => c.status !== 'ok').map(c => `${c.status} ${c.name}: ${c.message}`)).toEqual([]);
      expectHealthy(report, 'day zero');
    }, 150_000);

    test('day-zero doctor --remediate: nothing to do, nothing changed', async () => {
      const before = await brainState(home);
      const r = await cli(['doctor', '--remediate', '--json']);
      expect(r.exitCode, r.stderr).toBe(0);
      expect(oneDocument(r, 'doctor --remediate --json')).toMatchObject({ healthy: true, submitted: [], repairs_completed: 0 });
      expect(await brainState(home)).toEqual(before);
    }, 150_000);

    test(`import ${PAGES} pages --no-embed --json: one document`, async () => {
      const r = await cli(['import', writeNotes(home), '--no-embed', '--json']);
      expect(r.exitCode, r.stderr).toBe(0);
      expect(oneDocument(r, 'import --json')).toMatchObject({ status: 'success', imported: PAGES, errors: 0 });
    }, 150_000);

    test('doctor --remediate without authorization: exit 3, the consent payload, nothing mutated', async () => {
      await seedRepairableFinding(home);
      const before = await brainState(home);
      const r = await cli(['doctor', '--remediate', '--include-repairs', '--json']);
      expect(r.exitCode, r.stderr).toBe(3);
      const payload = oneDocument(r, 'doctor --remediate --json (refused)');
      expect(payload).toMatchObject({
        status: 'confirmation_required', error: 'confirmation_required', code: 'confirmation_required',
        effects: ['paid', 'destructive'], actor: 'agent', contract_version: 1,
      });
      expect(payload.fix.next).toBe('ask_user');
      expect(payload.fix.argv.slice(0, 3)).toEqual(['gbrain', 'doctor', '--remediate']);
      expect(payload.fix.argv).toEqual(expect.arrayContaining(['--yes', '--expect', payload.plan_hash]));
      expect(payload.user_message).toBeTruthy();
      expect(await brainState(home)).toEqual(before);

      // Human output on a non-TTY: the [AGENT] block with a fenced [SHOW USER] relay, still nothing changed.
      const human = await cli(['doctor', '--remediate', '--include-repairs']);
      expect(human.exitCode).toBe(3);
      expect(human.stdout).toContain('[AGENT]');
      expect(human.stdout).toContain('[SHOW USER]');
      expect(await brainState(home)).toEqual(before);
    }, 200_000);

    test('pending-migration brain: the refusal leaves the schema version unchanged; the approved fix migrates after consent', async () => {
      const pending = String(LATEST_VERSION - 1);
      await withBrain(home, engine => engine.setConfig('version', pending));
      const r = await cli(['doctor', '--remediate', '--include-repairs', '--json']);
      expect(r.exitCode, r.stderr).toBe(3);
      const payload = oneDocument(r, 'doctor --remediate --json (pending migration)');
      expect(payload.code).toBe('confirmation_required');
      await withBrain(home, async engine => {
        expect(await engine.getConfig('version')).toBe(pending);
        expect(await hasPendingMigrations(engine)).toBe(true);
      });

      // The user agreed: the agent runs fix.argv exactly as given.
      const fixArgv = payload.fix.argv as string[];
      expect(fixArgv[0]).toBe('gbrain');
      const approved = await cli(fixArgv.slice(1), 240_000);
      expect(approved.exitCode, approved.stderr.slice(-3000)).toBe(0);
      const result = oneDocument(approved, 'approved doctor --remediate');
      expect(result.repairs_completed).toBe(1);
      await withBrain(home, async engine => {
        expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));
      });
      const verify = await cli(['doctor', '--only', 'timeline_history', '--json']);
      expect(verify.exitCode, verify.stderr).toBe(0);
      const check = (oneDocument(verify, 'doctor --only timeline_history').checks as DoctorReport['checks']).find(c => c.name === 'timeline_history');
      expect(check?.status).toBe('ok');
    }, 300_000);

    test('after import and remediation: doctor --json health >= 90 with capped_by; every WARN has a fix', async () => {
      const r = await cli(['doctor', '--json']);
      expect(r.exitCode, r.stderr).toBe(0);
      expectHealthy(oneDocument(r, 'doctor --json (after import)') as DoctorReport, 'after import');
    }, 150_000);
  });
}

describe('H1a keyless MCP journey (stdio)', () => {
  let home = '';
  const open: McpSession[] = [];

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-journey-mcp-'));
    expect((await gb(home, ['init', '--pglite', '--no-embedding', '--json'], { timeoutMs: 120_000 })).exitCode).toBe(0);
    expect((await gb(home, ['import', writeNotes(home), '--no-embed', '--json'], { timeoutMs: 120_000 })).exitCode).toBe(0);
  }, 300_000);

  afterAll(async () => {
    for (const s of open) await s.close();
    rmSync(home, { recursive: true, force: true });
    try {
      mkdirSync(join(REPO, '.context'), { recursive: true });
      writeFileSync(join(REPO, '.context', 'agent-journey-timings.json'), `${JSON.stringify({ recorded_at: new Date().toISOString(), ...timings }, null, 2)}\n`);
    } catch { /* timings are informational */ }
    console.log(`[agent-journey] machine timings (ms): ${JSON.stringify(timings)}`);
  });

  test('surface verbs: remember/recall, the degraded notice block, a caller mistake with a runnable fix, status-only second serve', async () => {
    const verbs = await mcp(home, ['--surface', 'verbs']);
    open.push(verbs);
    timings.initialize_ms = verbs.initMs;
    const tools = (await verbs.client.listTools()).tools.map(t => t.name);
    expect(tools).toEqual(expect.arrayContaining(['remember', 'recall', 'forget']));
    expect(tools).not.toContain('get_health');
    expect(verbs.client.getInstructions()).toContain('recall');

    let t0 = performance.now();
    const remembered = await call(verbs, 'remember', { fact: `${MARKER} is the install-check fact`, provenance: 'install-check' });
    timings.first_remember_ms = Math.round(performance.now() - t0);
    expect(remembered.isError, JSON.stringify(remembered).slice(0, 1000)).toBeFalsy();

    t0 = performance.now();
    const recalled = await call(verbs, 'recall', { query: MARKER });
    timings.first_recall_ms = Math.round(performance.now() - t0);
    expect(recalled.isError).toBeFalsy();
    const text0 = recalled.content[0].text;
    expect(text0.startsWith(NOTICE_PREFIX)).toBe(false);
    const result = body(recalled);
    expect(JSON.stringify(result)).toContain(MARKER);
    expect(result.results.length).toBe(PAGES);
    // The degraded notice is its own prefixed block (the model sees it) and mirrored in _meta.
    const blocks = noticeBlocks(recalled);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.split('\n')[0]).toBe('[gbrain notice degraded_recall kind=degraded]');
    expect(blocks[0]).toContain('never as "the brain has nothing on this"');
    expect(recalled._meta?.gbrain_notices?.map((n: { code: string }) => n.code)).toEqual(['degraded_recall']);
    journeyGolden('recall-degraded.json', recalled, { home });

    // Caller mistake: one block, an envelope with a fix the agent runs as given.
    const mistake = await call(verbs, 'recall', { query: MARKER, limit: 'abc' });
    const env = expectOneBlockError(mistake, 'recall limit:"abc"');
    expect(env).toMatchObject({ error: 'invalid_params', code: 'invalid_params', class: 'caller', retryable: false });
    expect(env.fix.next).toBe('run');
    expect(env.fix.mcp).toEqual({ tool: 'recall', arguments: { query: MARKER, limit: 10 } });
    expect(env.suggestion).toContain('recall');
    journeyGolden('caller-mistake.json', mistake, { home });
    const fixed = await call(verbs, env.fix.mcp.tool, env.fix.mcp.arguments);
    expect(fixed.isError).toBeFalsy();
    expect(JSON.stringify(body(fixed))).toContain(MARKER);

    // F4: a second serve on the locked brain completes the handshake with gbrain_status naming the owner.
    const second = await mcp(home, []);
    open.push(second);
    expect(second.client.getInstructions()).toContain('STATUS-ONLY MODE');
    expect((await second.client.listTools()).tools.map(t => t.name)).toEqual(['gbrain_status']);
    const statusResult = await call(second, 'gbrain_status');
    const status = body(statusResult);
    expect(status).toMatchObject({ status: 'unavailable', reason: 'lock_held' });
    expect(status.lock_owner).toMatchObject({ pid: verbs.pid, transport: 'stdio' });
    expect(status.why).toContain(`PID ${verbs.pid}`);
    expect(status.fix.next).toBe('tell_user_to_run');
    expect(status.user_message).toBeTruthy();
    journeyGolden('status-only-lock-held.json', statusResult, { home, pids: [verbs.pid] });
    const refused = await call(second, 'recall', { query: MARKER });
    expect(expectOneBlockError(refused, 'recall on a status-only serve').code).toBe('serve_status_only');
    await second.close();
    await verbs.close();
  }, 240_000);

  test('surface full: search carries the degraded notice; a list_pages caller mistake carries a fix that runs', async () => {
    const full = await mcp(home, ['--surface', 'full']);
    open.push(full);
    const tools = (await full.client.listTools()).tools.map(t => t.name);
    expect(tools).toEqual(expect.arrayContaining(['search', 'query', 'list_pages', 'get_page', 'recall']));
    const found = await call(full, 'search', { query: MARKER });
    expect(found.isError).toBeFalsy();
    expect(Array.isArray(body(found))).toBe(true);
    expect(JSON.stringify(body(found))).toContain(MARKER);
    expect(noticeBlocks(found).map(b => b.split('\n')[0])).toEqual(['[gbrain notice degraded_recall kind=degraded]']);
    expect(found._meta?.gbrain_notices?.[0]?.code).toBe('degraded_recall');

    const mistake = await call(full, 'list_pages', { sort: 'bogus', limit: 2 });
    const env = expectOneBlockError(mistake, 'list_pages sort:"bogus"');
    expect(env.code).toBe('invalid_params');
    expect(env.fix).toMatchObject({ next: 'run', mcp: { tool: 'list_pages', arguments: { limit: 2 } } });
    const listed = await call(full, env.fix.mcp.tool, env.fix.mcp.arguments);
    expect(listed.isError).toBeFalsy();

    // A missing required param names the param; there is no value to invent, so no fix.
    const missing = expectOneBlockError(await call(full, 'get_page', {}), 'get_page {}');
    expect(missing.code).toBe('invalid_params');
    expect(missing.message).toContain('slug');
    await full.close();
  }, 240_000);

  test('the brain stays healthy after the MCP session: health >= 90 with capped_by', async () => {
    const r = await gb(home, ['doctor', '--json'], { timeoutMs: 120_000 });
    expect(r.exitCode).toBe(0);
    expectHealthy(oneDocument(r, 'doctor --json (after MCP)') as DoctorReport, 'after MCP');
    expect(timings.initialize_ms).toBeLessThan(30_000);
    expect(timings.first_recall_ms).toBeLessThan(30_000);
  }, 150_000);
});

describe('H2 missing_brain: the configured brain is on a drive that is not mounted', () => {
  let home = '';
  beforeAll(() => { home = mkdtempSync(join(tmpdir(), 'gbrain-journey-missing-')); });
  afterAll(() => { rmSync(home, { recursive: true, force: true }); });

  test('serve completes the handshake in status-only mode naming the path; nothing is created there; mounting it recovers in place', async () => {
    expect((await gb(home, ['init', '--pglite', '--no-embedding', '--json'])).exitCode).toBe(0);
    const offline = join(home, 'offline', 'brain.pglite');
    const mounted = join(home, 'mnt', 'external', 'gbrain', 'brain.pglite');
    mkdirSync(join(home, 'offline'), { recursive: true });
    renameSync(brainPath(home), offline);
    const cfgPath = join(home, '.gbrain', 'config.json');
    writeFileSync(cfgPath, JSON.stringify({ ...JSON.parse(readFileSync(cfgPath, 'utf8')), database_path: mounted }, null, 2));

    const session = await mcp(home, ['--surface', 'verbs']);
    try {
      expect(session.client.getInstructions()).toContain('STATUS-ONLY MODE');
      expect((await session.client.listTools()).tools.map(t => t.name)).toEqual(['gbrain_status']);
      const statusResult = await call(session, 'gbrain_status');
      const status = body(statusResult);
      expect(status).toMatchObject({ status: 'unavailable', reason: 'missing_brain', brain_path: mounted });
      expect(status.why).toContain(mounted);
      expect(status.fix.next).toBe('tell_user_to_run');
      expect(status.decisions[0].options.map((o: { id: string }) => o.id)).toEqual(['reconnect', 'new_brain']);
      expect(status.decisions[0].options[1].argv).toEqual(['gbrain', 'init', '--pglite', '--no-embedding', '--path', mounted]);
      journeyGolden('status-only-missing-brain.json', statusResult, { home });
      expect(existsSync(join(home, 'mnt'))).toBe(false);

      // The drive comes back: the next gbrain_status call opens the brain in place.
      mkdirSync(join(home, 'mnt', 'external', 'gbrain'), { recursive: true });
      renameSync(offline, mounted);
      let recovered = false;
      for (let i = 0; i < 40 && !recovered; i++) {
        recovered = body(await call(session, 'gbrain_status')).status === 'recovered';
        if (!recovered) await new Promise(r => setTimeout(r, 500));
      }
      expect(recovered).toBe(true);
    } finally {
      await session.close();
    }
  }, 180_000);
});
