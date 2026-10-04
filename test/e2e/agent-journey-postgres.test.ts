/**
 * Agent operator wave H4: Postgres parity for the DB-backed asserts of the H1
 * keyless journey (docs/designs/AGENT_OPERATOR_WAVE.md, Lane H).
 *
 * Each describe gets its own scratch database on the DATABASE_URL server
 * (`gbrain_test_agent_journey_<uuid>`, dropped afterwards) and a hermetic
 * HOME = GBRAIN_HOME from test/helpers/doctor-json-golden.ts (provider keys
 * removed, `fetch` refused by the no-network preload, non-TTY, stdin closed).
 * Every step is the real CLI (`bun --no-env-file src/cli.ts …`) or a real
 * stdio MCP session through @modelcontextprotocol/sdk, with hard timeouts.
 *
 * Journey on Postgres + pgvector, keyless:
 *   init --url --no-embedding --json (one document, the decision bundle)
 *   → day-zero doctor --json: zero warn/fail, health ≥ 90, capped_by
 *   → import 3 pages
 *   → doctor --remediate without authorization on a pending-migration
 *     fixture: exit 3, confirmation_required (ask_user), nothing submitted,
 *     no page changed, schema version unchanged (observational startup)
 *   → stdio serve on `verbs` and `full`: handshake with the full catalog (no
 *     status-only tool: that mode is PGLite-lock specific), the degraded
 *     recall notice as a separate `[gbrain notice ` block + _meta.gbrain_notices
 *     with content[0] still the bare result, caller mistakes as one isError
 *     block (invalid_params: class, docs_cmd and an example call; a missing
 *     page: a runnable `fix` with the MCP re-invocation), the stdio wire value
 *     for an unknown tool unchanged from v0.60.37, readiness on
 *     gbrain://capabilities
 *   → doctor: agent_contract (E11) warns about the refused unattended run with
 *     the preapproval fix; with that engine-independent log set aside, health
 *     ≥ 90 with capped_by.
 * Postgres readiness (F4 keeps the existing degraded-serve path for Postgres):
 * a serve whose database does not exist yet completes the handshake, every
 * tool call returns one classified isError block with a fix, and once the
 * database exists (`gbrain init`, the fix) the same session recovers and
 * recalls without a restart.
 *
 * Tier 1 (no API keys). Skips without DATABASE_URL.
 * Run: DATABASE_URL=... bun test test/e2e/agent-journey-postgres.test.ts
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import postgres from '#postgres';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { makeDoctorHome, networkAttempts, runGbrain, type DoctorHome, type GbrainRun } from '../helpers/doctor-json-golden.ts';
import { PROVIDER_ENV_KEYS } from '../helpers/provider-env.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const describeE2E = DATABASE_URL ? describe : describe.skip;
if (!DATABASE_URL) console.log('Skipping E2E agent journey on Postgres (DATABASE_URL not set)');

const CLI = join(import.meta.dir, '..', '..', 'src', 'cli.ts');
const PRELOAD = join(import.meta.dir, '..', 'helpers', 'no-network-preload.ts');
const MARKER = 'zelkova-pg-journey-7k2';
const NOTICE_PREFIX = '[gbrain notice ';

const homes: DoctorHome[] = [];
const drops: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const drop of drops) await drop();
  for (const h of homes) h.cleanup();
});

function admin() {
  return postgres(DATABASE_URL!, { max: 1, prepare: false });
}

/** A scratch database name on the DATABASE_URL server; `create` false leaves it absent. */
async function scratchDatabase(create = true): Promise<{ name: string; url: string; sql: ReturnType<typeof postgres> }> {
  assertSafeE2eDatabaseUrl(DATABASE_URL!);
  const name = `gbrain_test_agent_journey_${randomUUID().replaceAll('-', '')}`;
  const sql = admin();
  if (create) await sql.unsafe(`CREATE DATABASE ${name}`);
  const url = new URL(DATABASE_URL!);
  url.pathname = `/${name}`;
  drops.push(async () => {
    try { await sql.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); } finally { await sql.end(); }
  });
  return { name, url: url.toString(), sql };
}

async function brainQuery<T>(url: string, fn: (sql: ReturnType<typeof postgres>) => Promise<T>): Promise<T> {
  const sql = postgres(url, { max: 1, prepare: false });
  try { return await fn(sql); } finally { await sql.end(); }
}

function doc(run: GbrainRun): Record<string, any> {
  if (run.json === null || typeof run.json !== 'object') {
    throw new Error(`gbrain ${run.args.join(' ')} (exit ${run.exitCode}) did not print one JSON document.\nstdout: ${run.stdout.slice(0, 2000)}\nstderr: ${run.stderr.slice(0, 2000)}`);
  }
  return run.json as Record<string, any>;
}

function notOk(report: Record<string, any>): string[] {
  return (report.checks as Array<{ name: string; status: string; message: string }>)
    .filter(c => c.status !== 'ok').map(c => `${c.name} ${c.status}: ${c.message}`);
}

/** The hermetic child env runGbrain uses, for the MCP serve child. */
function serveEnv(h: DoctorHome): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  for (const k of PROVIDER_ENV_KEYS) delete env[k];
  for (const k of ['DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_REMOTE_CLIENT_SECRET', 'GBRAIN_PGLITE_SNAPSHOT', 'GBRAIN_SKILLS_DIR', 'GBRAIN_SOURCE',
    'GBRAIN_SERVE_FAIL_FAST', 'GBRAIN_SERVE_DEGRADED', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX', 'CODEX_CI', 'CODEX_HOME', 'OPENCODE', 'OPENCODE_PID']) delete env[k];
  Object.assign(env, {
    HOME: h.home, GBRAIN_HOME: h.home, GBRAIN_AUDIT_DIR: join(h.home, 'audit'), GBRAIN_SKIP_STARTUP_HOOKS: '1',
    GBRAIN_TEST_NET_LOG: h.netLog, NO_COLOR: '1', GBRAIN_NO_RETRY_CONNECT: '1',
  });
  return env;
}

interface Session { client: Client; stderr: () => string; initializeMs: number }

async function openServe(h: DoctorHome, surface: string): Promise<Session> {
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['--no-env-file', '--preload', PRELOAD, CLI, 'serve', '--surface', surface],
    cwd: h.work, env: serveEnv(h), stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
  const client = new Client({ name: 'agent-journey-postgres', version: '1.0.0' }, { capabilities: {} });
  const started = Date.now();
  await client.connect(transport, { timeout: 60_000 });
  return { client, stderr: () => stderr, initializeMs: Date.now() - started };
}

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean; _meta?: Record<string, unknown> };

async function call(s: Session, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return await s.client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 }) as ToolResult;
}

function expectOneBlockError(res: ToolResult, label: string): Record<string, any> {
  expect(res.isError, `${label}: ${JSON.stringify(res).slice(0, 800)}`).toBe(true);
  expect(res.content).toHaveLength(1);
  const env = JSON.parse(res.content[0].text) as Record<string, any>;
  expect(typeof env.error).toBe('string');
  expect(typeof env.code).toBe('string');
  expect(env.contract_version).toBe(1);
  return env;
}

function expectDegradedNotice(res: ToolResult, label: string): void {
  expect(res.isError, label).toBeFalsy();
  expect(res.content[0].text.startsWith(NOTICE_PREFIX), `${label}: content[0] must stay the bare result`).toBe(false);
  const blocks = res.content.slice(1).filter(c => c.text.startsWith(NOTICE_PREFIX));
  expect(blocks.some(b => b.text.startsWith(`${NOTICE_PREFIX}degraded_recall kind=degraded]`)), `${label}: ${JSON.stringify(res.content.map(c => c.text.slice(0, 80)))}`).toBe(true);
  const meta = (res._meta?.gbrain_notices ?? []) as Array<{ code: string; kind: string; contract_version: number }>;
  expect(meta.some(n => n.code === 'degraded_recall' && n.kind === 'degraded' && n.contract_version === 1)).toBe(true);
}

describeE2E('H4: keyless agent journey on Postgres', () => {
  let h: DoctorHome;
  let db: { name: string; url: string };
  const timings: Record<string, number> = {};

  test('init --url --no-embedding --json prints one document with the decision bundle', async () => {
    db = await scratchDatabase();
    h = makeDoctorHome('agent-journey-pg');
    homes.push(h);
    // A first install has no skills workspace in HOME (test/doctor-day-zero.serial.test.ts does the same).
    rmSync(h.skillsDir, { recursive: true, force: true });
    const started = Date.now();
    const init = await runGbrain(h, ['init', '--non-interactive', '--url', db.url, '--no-embedding', '--json'], {}, 120_000);
    timings.init_ms = Date.now() - started;
    expect(init.exitCode, init.stderr).toBe(0);
    const out = doc(init);
    expect(out).toMatchObject({ status: 'success', engine: 'postgres', contract_version: 1 });
    const bundle = (out.notices as Array<Record<string, any>>).find(n => n.code === 'first_run_decisions');
    expect(bundle).toMatchObject({ kind: 'ask', contract_version: 1 });
    expect((bundle!.decisions as Array<{ id: string }>).map(d => d.id)).toContain('search_mode');
  }, 180_000);

  test('day-zero doctor --json: no warn or fail, health ≥ 90, capped_by names the keyless cap', async () => {
    const run = await runGbrain(h, ['doctor', '--json']);
    const report = doc(run);
    expect(report.engine).toBe('postgres');
    expect(notOk(report)).toEqual([]);
    expect(report.health_score).toBeGreaterThanOrEqual(90);
    expect(report.capped_by).toContain('embeddings_disabled');
    expect(networkAttempts(h)).toEqual([]);
  }, 180_000);

  test('import 3 pages', async () => {
    const notes = join(h.home, 'notes');
    mkdirSync(notes, { recursive: true });
    for (const n of ['alpha', 'beta', 'gamma']) {
      writeFileSync(join(notes, `${n}.md`), `---\ntitle: ${n} note\n---\n\n# ${n} note\n\nThe ${MARKER} ${n} fact lives here.\n`);
    }
    const run = await runGbrain(h, ['import', notes, '--no-embed']);
    expect(run.exitCode, run.stderr).toBe(0);
    expect(run.stdout).toContain('3 pages imported');
    const [{ n }] = await brainQuery(db.url, sql => sql`SELECT count(*)::int AS n FROM pages`);
    expect(n).toBe(3);
  }, 120_000);

  test('doctor --remediate without authorization on a pending-migration brain: exit 3, nothing runs, schema version unchanged', async () => {
    const latest = await brainQuery(db.url, sql => sql`SELECT value FROM config WHERE key = 'version'`);
    const pending = String(Number(latest[0].value) - 3);
    await brainQuery(db.url, sql => sql`UPDATE config SET value = ${pending} WHERE key = 'version'`);
    const snapshot = () => brainQuery(db.url, async sql => JSON.stringify({
      pages: await sql`SELECT slug, content_hash, updated_at::text AS u FROM pages ORDER BY slug`,
      links: await sql`SELECT count(*)::int AS n FROM links`,
      timeline: await sql`SELECT count(*)::int AS n FROM timeline_entries`,
      jobs: await sql`SELECT count(*)::int AS n FROM minion_jobs`,
      version: await sql`SELECT value FROM config WHERE key = 'version'`,
    }));
    const before = await snapshot();
    // The keyless ceiling caps the default target 90; a reachable target makes the extract step runnable.
    const run = await runGbrain(h, ['doctor', '--remediate', '--target-score', '30', '--json'], { GBRAIN_NON_INTERACTIVE: '1' });
    expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(3);
    const payload = doc(run);
    expect(payload).toMatchObject({ status: 'confirmation_required', error: 'confirmation_required', code: 'confirmation_required', actor: 'agent', contract_version: 1 });
    expect(payload.effects).toContain('paid');
    expect(payload.fix.next).toBe('ask_user');
    expect(payload.fix.argv).toContain('--yes');
    expect(typeof payload.user_message).toBe('string');
    expect(await snapshot()).toBe(before);
    expect((await brainQuery(db.url, sql => sql`SELECT value FROM config WHERE key = 'version'`))[0].value).toBe(pending);

    // What the refusal asked about is real: the plan has a runnable step at that target.
    // (`--remediation-plan` is not observational: its normal startup applies the pending migrations.)
    const plan = doc(await runGbrain(h, ['doctor', '--remediation-plan', '--target-score', '30', '--json']));
    expect(plan.target_unreachable).toBe(false);
    expect((plan.plan as Array<{ id: string }>).map(step => step.id)).toContain('extract.stale');

    // Doctor's normal (non-observational) startup leaves the schema current.
    const migrated = await runGbrain(h, ['doctor', '--json']);
    expect(migrated.exitCode, migrated.stderr).toBe(0);
    expect((await brainQuery(db.url, sql => sql`SELECT value FROM config WHERE key = 'version'`))[0].value).toBe(latest[0].value);
  }, 240_000);

  for (const surface of ['verbs', 'full'] as const) {
    test(`stdio serve --surface ${surface}: handshake, degraded notice channel, one-block caller mistake with fix, readiness`, async () => {
      const s = await openServe(h, surface);
      try {
        timings[`initialize_${surface}_ms`] = s.initializeMs;
        expect(s.client.getServerVersion()?.name).toBeTruthy();
        const instructions = s.client.getInstructions() ?? '';
        expect(instructions).toContain(NOTICE_PREFIX.trim());
        const tools = (await s.client.listTools()).tools.map(t => t.name);
        expect(tools).toContain('recall');
        expect(tools).not.toContain('gbrain_status');
        if (surface === 'verbs') expect(tools).not.toContain('search');
        else expect(tools).toContain('search');

        const op = surface === 'verbs' ? 'recall' : 'search';
        const started = Date.now();
        const found = await call(s, op, { query: MARKER });
        timings[`first_${op}_${surface}_ms`] = Date.now() - started;
        expectDegradedNotice(found, `${surface} ${op}`);
        const body = JSON.parse(found.content[0].text);
        expect(JSON.stringify(body)).toContain(MARKER);
        if (op === 'search') expect(Array.isArray(body)).toBe(true);
        const again = await call(s, op, { query: MARKER });
        expect(again.content.some(c => c.text.startsWith(`${NOTICE_PREFIX}degraded_recall`)), 'stdio delivers the degraded notice once per session').toBe(false);

        const mistake = expectOneBlockError(await call(s, op, { query: 5 }), `${surface} ${op} with a non-string query`);
        expect(mistake).toMatchObject({ code: 'invalid_params', class: 'caller', retryable: false, docs_cmd: ['gbrain', 'errors', 'invalid_params'] });
        expect(mistake.suggestion).toContain(`Example: ${op} {"query": `);

        if (surface === 'full') {
          const missing = expectOneBlockError(await call(s, 'get_page', { slug: 'h4-no-such-page' }), 'get_page on a missing slug');
          expect(missing.code).toBe('page_not_found');
          expect(missing.fix).toMatchObject({ next: 'run', actor: 'agent', consent: [], mcp: { tool: 'get_page', arguments: { slug: 'h4-no-such-page', include_deleted: true } } });
          const followed = await call(s, missing.fix.mcp.tool, missing.fix.mcp.arguments);
          expect(expectOneBlockError(followed, 'the fix, followed').code).toBe('page_not_found');
        }

        // stdio keeps the v0.60.37 wire value for an unknown tool (HTTP's frozen value is unknown_operation).
        const unknown = expectOneBlockError(await call(s, 'no_such_tool_h4', {}), 'unknown tool');
        expect(unknown.error).toBe('unknown_tool');
        expect(unknown.code).toBe('unknown_tool');

        const caps = await s.client.readResource({ uri: 'gbrain://capabilities' });
        const capabilities = JSON.parse((caps.contents[0] as { text: string }).text) as Record<string, any>;
        expect(Array.isArray(capabilities.readiness)).toBe(true);
        const embeddings = (capabilities.readiness as Array<Record<string, any>>).find(r => /embed/.test(String(r.capability ?? r.id ?? r.name)));
        expect(embeddings, JSON.stringify(capabilities.readiness)).toBeDefined();
      } finally {
        await s.client.close();
      }
      expect(networkAttempts(h)).toEqual([]);
    }, 180_000);
  }

  test('after the journey: E11 recorded the refusal; health ≥ 90 with capped_by; timings recorded', async () => {
    const report = doc(await runGbrain(h, ['doctor', '--json']));
    const contract = (report.checks as Array<Record<string, any>>).find(c => c.name === 'agent_contract')!;
    expect(contract.status).toBe('warn');
    expect(contract.message).toContain('doctor --remediate×1');
    expect(contract.fix).toMatchObject({ actor: 'user', consent: ['paid'] });
    expect(contract.fix.argv.slice(0, 3)).toEqual(['gbrain', 'config', 'set']);
    // The E11 log is a GBRAIN_HOME file (engine-independent) and keeps that deliberate refusal as a warn for 7 days;
    // the brain's own health is scored with it set aside.
    const events = join(h.home, '.gbrain', 'agent-contract', 'events.jsonl');
    renameSync(events, `${events}.journey`);
    try {
      const brain = doc(await runGbrain(h, ['doctor', '--json']));
      expect(brain.health_score, notOk(brain).join('\n')).toBeGreaterThanOrEqual(90);
      expect(brain.capped_by).toContain('embeddings_disabled');
    } finally {
      renameSync(`${events}.journey`, events);
    }
    for (const key of ['init_ms', 'initialize_verbs_ms', 'initialize_full_ms']) expect(timings[key]).toBeGreaterThan(0);
    console.log(`[agent-journey-postgres] timings ${JSON.stringify(timings)}`);
  }, 180_000);
});

describeE2E('H4: Postgres serve readiness keeps the degraded-serve path', () => {
  test('a database that does not exist yet: handshake, classified one-block errors with a fix, recovery in place after init', async () => {
    const db = await scratchDatabase(false);
    const h = makeDoctorHome('agent-journey-pg-degraded');
    homes.push(h);
    mkdirSync(join(h.home, '.gbrain'), { recursive: true });
    writeFileSync(join(h.home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'postgres', database_url: db.url, embedding_disabled: true }));

    const s = await openServe(h, 'verbs');
    try {
      const tools = (await s.client.listTools()).tools.map(t => t.name);
      expect(tools).toContain('recall');
      expect(tools).not.toContain('gbrain_status');
      const down = expectOneBlockError(await call(s, 'recall', { query: MARKER }), 'recall on a missing database');
      expect(down).toMatchObject({ error: 'unavailable', code: 'unavailable', reason: 'db_missing', protocol_version: 1 });
      // A1 surface rule: a CLI-only fix over stdio is the user's to run on this machine (host_admin is HTTP's actor).
      // A1: the fix names the served brain explicitly.
      expect(down.fix).toMatchObject({ argv: ['gbrain', 'db-repair', '--brain', 'host'], actor: 'user', next: 'tell_user_to_run' });
      expect(JSON.stringify(down)).not.toContain(db.url);

      await db.sql.unsafe(`CREATE DATABASE ${db.name}`);
      const init = await runGbrain(h, ['init', '--non-interactive', '--url', db.url, '--no-embedding']);
      expect(init.exitCode, init.stderr).toBe(0);
      const remembered = await (async () => {
        const end = Date.now() + 60_000;
        let last: ToolResult | null = null;
        while (Date.now() < end) {
          last = await call(s, 'remember', { fact: `${MARKER} survives a database outage`, provenance: 'agent-journey-postgres' });
          if (!last.isError) return last;
          await Bun.sleep(1_000);
        }
        throw new Error(`the degraded serve never recovered: ${JSON.stringify(last).slice(0, 800)}\n${s.stderr().slice(-2000)}`);
      })();
      expect(remembered.isError).toBeFalsy();
      const recalled = await call(s, 'recall', { query: MARKER });
      expect(recalled.isError).toBeFalsy();
      expect(recalled.content[0].text).toContain(MARKER);
    } finally {
      await s.client.close();
    }
  }, 240_000);
});
