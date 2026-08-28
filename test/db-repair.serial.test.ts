/**
 * `gbrain db-repair` — engine-free Postgres-access repair. In-process tests
 * against runDbRepair via the exported DbRepairDeps seam: probes are queued
 * fake diagnoses (built with the real classifier so shapes never drift),
 * docker is absent, sleep is a no-op, now is frozen. GBRAIN_HOME points at a
 * fresh temp dir per test so config/receipts/undo/lock files stay hermetic.
 *
 * Pins the consent ladder end to end:
 *   - flag gating (--apply-rewrites/--undo-last-rewrite require --yes)
 *   - refusal paths (no config, pglite redirect, thin client, env-source URL)
 *   - diagnose-only default mutates nothing
 *   - auto tier (bounded reconnect), manual tier (recipe only, no writes)
 *   - rewrite tier: gating, candidate-probe-before-persist, undo file (0600),
 *     24h cooldown on applied rows only, --force bypass, --undo-last-rewrite
 *   - receipts cap + advisory lock liveness
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runDbRepair, type DbRepairDeps } from '../src/commands/db-repair.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { classifyPgAccessError, type PgAccessDiagnosis } from '../src/core/pg-access-classify.ts';
import { RECEIPTS_CAP, readReceipts, receiptsPath, rewriteCooldownBlocked, writeReceipt, type RepairReceipt } from '../src/core/db-repair-receipts.ts';
import { deriveSessionPoolerUrl } from '../src/core/connection-manager.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXED_NOW = Date.now();
const HOUR = 3600_000;

const PLAIN_PG_URL = 'postgresql://u:pw@localhost:5432/gbrain';
const POOLER_URL = 'postgresql://postgres.abc123:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres';
const SESSION_URL = deriveSessionPoolerUrl(POOLER_URL)!;

function errWith(code: string, message: string): Error {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  return e;
}

const connRefusedDiag = (url: string = PLAIN_PG_URL): PgAccessDiagnosis =>
  classifyPgAccessError(errWith('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:5432'), { url, source: 'config-file' });
const sslRequiredDiag = (url: string = PLAIN_PG_URL): PgAccessDiagnosis =>
  classifyPgAccessError(
    new Error('no pg_hba.conf entry for host "1.2.3.4", user "u", database "d", no encryption'),
    { url, source: 'config-file' },
  );
const connDroppedDiag = (): PgAccessDiagnosis =>
  classifyPgAccessError(errWith('CONNECTION_ENDED', 'CONNECTION_ENDED: the connection was ended'), { url: PLAIN_PG_URL, source: 'config-file' });
const authFailedDiag = (): PgAccessDiagnosis =>
  classifyPgAccessError(errWith('28P01', 'password authentication failed for user "postgres"'), { url: PLAIN_PG_URL, source: 'config-file' });
const netUnreachDiag = (url: string = POOLER_URL): PgAccessDiagnosis =>
  classifyPgAccessError(errWith('ETIMEDOUT', 'connect ETIMEDOUT 1.2.3.4:5432'), { url, source: 'config-file' });

interface FakeDeps {
  deps: DbRepairDeps;
  accessCalls: Array<{ url: string | null | undefined; attempts: number | undefined }>;
}

/** Queued-diagnosis deps: probes shift their queue; exhausted queue = healthy.
 *  `docker`/`withEngine` are injectable for the docker arm + healthy-path
 *  bonus-report tests; the defaults keep every other test's guarantees
 *  (docker absent, withEngine unreachable). */
function makeDeps(
  opts: {
    access?: Array<PgAccessDiagnosis | null>;
    schema?: Array<PgAccessDiagnosis | null>;
    now?: number;
    docker?: DbRepairDeps['docker'];
    withEngine?: DbRepairDeps['withEngine'];
  } = {},
): FakeDeps {
  const accessQueue = [...(opts.access ?? [])];
  const schemaQueue = [...(opts.schema ?? [])];
  const accessCalls: FakeDeps['accessCalls'] = [];
  const deps: DbRepairDeps = {
    async probeAccess(config, attempts) {
      accessCalls.push({ url: config.database_url, attempts });
      return accessQueue.length > 0 ? accessQueue.shift()! : null;
    },
    async probeSchema() {
      return schemaQueue.length > 0 ? schemaQueue.shift()! : null;
    },
    withEngine:
      opts.withEngine ??
      (async () => {
        throw new Error('withEngine must not be reached in these tests');
      }),
    docker: opts.docker ?? { available: () => false, state: () => 'absent' as const, start: () => false },
    sleep: async () => {},
    now: () => opts.now ?? FIXED_NOW,
  };
  return { deps, accessCalls };
}

// ---------------------------------------------------------------------------
// Hermetic home + console capture
// ---------------------------------------------------------------------------

const ENV_KEYS = ['GBRAIN_HOME', 'GBRAIN_DATABASE_URL', 'DATABASE_URL', 'GBRAIN_BRAIN_ID', 'GBRAIN_MOUNTS_PATH'] as const;
const envSnapshot: Record<string, string | undefined> = {};

let home: string;
let logs: string[];
let errs: string[];
let logSpy: ReturnType<typeof spyOn>;
let errSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  for (const k of ENV_KEYS) envSnapshot[k] = process.env[k];
  home = mkdtempSync(join(tmpdir(), 'gbrain-db-repair-'));
  process.env.GBRAIN_HOME = home;
  delete process.env.GBRAIN_DATABASE_URL;
  delete process.env.DATABASE_URL;
  delete process.env.GBRAIN_BRAIN_ID;
  delete process.env.GBRAIN_MOUNTS_PATH;
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  logs = [];
  errs = [];
  logSpy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
  errSpy = spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errs.push(a.map(String).join(' ')); });
});

afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  for (const k of ENV_KEYS) {
    if (envSnapshot[k] === undefined) delete process.env[k];
    else process.env[k] = envSnapshot[k];
  }
  rmSync(home, { recursive: true, force: true });
});

function configPath(): string {
  return join(home, '.gbrain', 'config.json');
}

function writeConfig(cfg: Record<string, unknown>): void {
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + '\n');
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(configPath(), 'utf-8'));
}

function undoFile(): string {
  return join(home, '.gbrain', 'db-repair-undo.json');
}

function lockFile(): string {
  return join(home, '.gbrain', 'db-repair.lock');
}

function receipt(overrides: Partial<RepairReceipt>): RepairReceipt {
  return { ts: FIXED_NOW, brain_id: 'host', reason: 'network_unreachable', action: 'rewrite_to_session_pooler', outcome: 'applied', ...overrides };
}

// ---------------------------------------------------------------------------

describe('db-repair flag gating', () => {
  test('unknown flag → exit 2', async () => {
    expect(await runDbRepair(['--wat'], makeDeps().deps)).toBe(2);
    expect(errs.join('\n')).toContain('Unknown flag for db-repair');
  });

  test('--apply-rewrites without --yes → exit 2', async () => {
    expect(await runDbRepair(['--apply-rewrites'], makeDeps().deps)).toBe(2);
    expect(errs.join('\n')).toContain('--apply-rewrites requires --yes');
  });

  test('--undo-last-rewrite without --yes → exit 2', async () => {
    expect(await runDbRepair(['--undo-last-rewrite'], makeDeps().deps)).toBe(2);
    expect(errs.join('\n')).toContain('--undo-last-rewrite requires --yes');
  });

  test('--help → exit 0', async () => {
    expect(await runDbRepair(['--help'], makeDeps().deps)).toBe(0);
    expect(logs.join('\n')).toContain('gbrain db-repair');
  });
});

describe('db-repair refusal paths', () => {
  test('no config → exit 1 with the manual no_url path + diagnose receipt', async () => {
    const { deps } = makeDeps();
    expect(await runDbRepair([], deps)).toBe(1);
    const rows = readReceipts();
    expect(rows.length).toBe(1);
    expect(rows[0].reason).toBe('no_url');
    expect(rows[0].outcome).toBe('diagnose');
  });

  test('pglite config → exit 1 with the pglite-repair redirect', async () => {
    writeConfig({ engine: 'pglite', database_path: join(home, '.gbrain', 'brain.pglite') });
    expect(await runDbRepair([], makeDeps().deps)).toBe(1);
    expect(errs.join('\n')).toContain('pglite-repair');
  });

  test('thin-client config → exit 1 (no local database to repair)', async () => {
    writeConfig({ remote_mcp: { url: 'https://brain.example.com/mcp' } });
    expect(await runDbRepair([], makeDeps().deps)).toBe(1);
    expect(errs.join('\n')).toContain('thin client');
  });
});

describe('db-repair diagnose + auto/manual tiers', () => {
  test('healthy probes → exit 0, diagnose receipt', async () => {
    writeConfig({ engine: 'postgres', database_url: PLAIN_PG_URL });
    const { deps } = makeDeps({ access: [null], schema: [null] });
    expect(await runDbRepair([], deps)).toBe(0);
    const rows = readReceipts();
    expect(rows.length).toBe(1);
    expect(rows[0].outcome).toBe('diagnose');
    expect(rows[0].action).toBe('diagnose_healthy');
  });

  test('diagnose-only default: conn_refused, no --yes → exit 1, config byte-unchanged', async () => {
    writeConfig({ engine: 'postgres', database_url: PLAIN_PG_URL });
    const before = readFileSync(configPath(), 'utf-8');
    const d = connRefusedDiag();
    expect(d.reason).toBe('conn_refused');
    const { deps, accessCalls } = makeDeps({ access: [d] });
    expect(await runDbRepair([], deps)).toBe(1);
    expect(accessCalls.length).toBe(1); // diagnose only — no repair probes
    const rows = readReceipts();
    expect(rows.length).toBe(1);
    expect(rows[0].outcome).toBe('diagnose');
    expect(rows[0].reason).toBe('conn_refused');
    expect(readFileSync(configPath(), 'utf-8')).toBe(before);
    expect(existsSync(undoFile())).toBe(false);
  });

  test('auto tier: conn_dropped + --yes, retry probe (attempts=3) heals → exit 0, bounded_reconnect applied', async () => {
    writeConfig({ engine: 'postgres', database_url: PLAIN_PG_URL });
    const d = connDroppedDiag();
    expect(d.reason).toBe('conn_dropped');
    const { deps, accessCalls } = makeDeps({ access: [d, null] });
    expect(await runDbRepair(['--yes'], deps)).toBe(0);
    expect(accessCalls[1].attempts).toBe(3); // the bounded reconnect ladder
    const applied = readReceipts().filter((r) => r.outcome === 'applied');
    expect(applied.length).toBe(1);
    expect(applied[0].action).toBe('bounded_reconnect');
    expect(applied[0].reason).toBe('conn_dropped');
  });

  test('manual tier: auth_failed + --yes → exit 1, no applied receipts, config unchanged', async () => {
    writeConfig({ engine: 'postgres', database_url: PLAIN_PG_URL });
    const before = readFileSync(configPath(), 'utf-8');
    const d = authFailedDiag();
    expect(d.reason).toBe('auth_failed');
    const { deps } = makeDeps({ access: [d] });
    expect(await runDbRepair(['--yes'], deps)).toBe(1);
    expect(readReceipts().filter((r) => r.outcome === 'applied').length).toBe(0);
    expect(readFileSync(configPath(), 'utf-8')).toBe(before);
    expect(logs.join('\n')).toContain('Manual fix required');
  });
});

describe('db-repair rewrite tier', () => {
  test('network_unreachable + --yes WITHOUT --apply-rewrites → refused, exit 1, config unchanged', async () => {
    writeConfig({ engine: 'postgres', database_url: POOLER_URL });
    const before = readFileSync(configPath(), 'utf-8');
    const d = netUnreachDiag();
    expect(d.reason).toBe('network_unreachable');
    const { deps } = makeDeps({ access: [d] });
    expect(await runDbRepair(['--yes'], deps)).toBe(1);
    const rows = readReceipts();
    expect(rows.length).toBe(1);
    expect(rows[0].outcome).toBe('refused');
    expect(rows[0].action).toBe('rewrite_to_session_pooler');
    expect(readFileSync(configPath(), 'utf-8')).toBe(before);
    expect(existsSync(undoFile())).toBe(false);
    expect(logs.join('\n')).toContain('--apply-rewrites');
  });

  test('--yes --apply-rewrites: candidate probes healthy → session-pooler rewrite persisted + 0600 undo file', async () => {
    writeConfig({ engine: 'postgres', database_url: POOLER_URL });
    // Probe order: initial access (fails) → candidate probe → post-persist re-probe.
    const { deps, accessCalls } = makeDeps({ access: [netUnreachDiag(), null, null] });
    expect(await runDbRepair(['--yes', '--apply-rewrites'], deps)).toBe(0);

    // Config now carries the session-pooler form: same host, port 5432.
    const cfg = readConfig();
    expect(cfg.database_url).toBe(SESSION_URL);
    expect(String(cfg.database_url)).toContain('aws-0-us-east-1.pooler.supabase.com:5432');
    expect(cfg.engine).toBe('postgres');

    // Candidate was probed BEFORE persisting, against the new URL.
    expect(accessCalls[1].url).toBe(SESSION_URL);
    expect(accessCalls[2].url).toBe(SESSION_URL);

    // Undo file holds the PRIOR (secret) url at mode 0600.
    expect(existsSync(undoFile())).toBe(true);
    const undo = JSON.parse(readFileSync(undoFile(), 'utf-8'));
    expect(undo.prior_url).toBe(POOLER_URL);
    expect(statSync(undoFile()).mode & 0o777).toBe(0o600);

    const applied = readReceipts().filter((r) => r.outcome === 'applied');
    expect(applied.length).toBe(1);
    expect(applied[0].action).toBe('rewrite_to_session_pooler');
  });

  test('candidate probe fails → rewrite refused, config unchanged', async () => {
    writeConfig({ engine: 'postgres', database_url: POOLER_URL });
    const before = readFileSync(configPath(), 'utf-8');
    const { deps } = makeDeps({ access: [netUnreachDiag(), netUnreachDiag(SESSION_URL)] });
    expect(await runDbRepair(['--yes', '--apply-rewrites'], deps)).toBe(1);
    expect(readFileSync(configPath(), 'utf-8')).toBe(before);
    expect(existsSync(undoFile())).toBe(false);
    const rows = readReceipts();
    expect(rows.filter((r) => r.outcome === 'applied').length).toBe(0);
    expect(rows.filter((r) => r.outcome === 'refused').length).toBe(1);
  });

  test('cooldown: applied same (reason, action) 1h ago → refused; --force bypasses', async () => {
    writeConfig({ engine: 'postgres', database_url: POOLER_URL });
    writeReceipt(receipt({ ts: FIXED_NOW - HOUR }));

    const first = makeDeps({ access: [netUnreachDiag()] });
    expect(await runDbRepair(['--yes', '--apply-rewrites'], first.deps)).toBe(1);
    expect(readConfig().database_url).toBe(POOLER_URL); // unchanged
    const refusedRows = readReceipts().filter((r) => r.outcome === 'refused');
    expect(refusedRows.length).toBe(1);
    expect(errs.concat(logs).join('\n')).toContain('cooldown');

    const forced = makeDeps({ access: [netUnreachDiag(), null, null] });
    expect(await runDbRepair(['--yes', '--apply-rewrites', '--force'], forced.deps)).toBe(0);
    expect(readConfig().database_url).toBe(SESSION_URL);
  });

  test("cooldown: 'refused'/'diagnose' rows never block a rewrite", async () => {
    writeConfig({ engine: 'postgres', database_url: POOLER_URL });
    writeReceipt(receipt({ ts: FIXED_NOW - 1000, outcome: 'refused' }));
    writeReceipt(receipt({ ts: FIXED_NOW - 1000, outcome: 'diagnose' }));
    const { deps } = makeDeps({ access: [netUnreachDiag(), null, null] });
    expect(await runDbRepair(['--yes', '--apply-rewrites'], deps)).toBe(0);
    expect(readConfig().database_url).toBe(SESSION_URL);
  });

  test('undo: --yes --undo-last-rewrite restores the prior url; the undo file now points back at the rewrite', async () => {
    writeConfig({ engine: 'postgres', database_url: POOLER_URL });
    const rewrite = makeDeps({ access: [netUnreachDiag(), null, null] });
    expect(await runDbRepair(['--yes', '--apply-rewrites'], rewrite.deps)).toBe(0);
    expect(readConfig().database_url).toBe(SESSION_URL);

    const undo = makeDeps({ access: [null] });
    expect(await runDbRepair(['--yes', '--undo-last-rewrite'], undo.deps)).toBe(0);
    expect(readConfig().database_url).toBe(POOLER_URL);
    // Undo is itself reversible: the outgoing (rewritten) URL becomes the
    // new undo record so an accidental undo can't destroy a probed fix.
    expect(existsSync(undoFile())).toBe(true);
    expect(JSON.parse(readFileSync(undoFile(), 'utf-8')).prior_url).toBe(SESSION_URL);
    expect(undo.accessCalls[0].url).toBe(POOLER_URL); // re-probed against the restored url
    const undoRows = readReceipts().filter((r) => r.reason === 'undo');
    expect(undoRows.length).toBe(1);
    expect(undoRows[0].action).toBe('undo_last_rewrite');
    expect(undoRows[0].outcome).toBe('applied');
  });

  test('undo with no undo record → exit 1', async () => {
    writeConfig({ engine: 'postgres', database_url: POOLER_URL });
    expect(await runDbRepair(['--yes', '--undo-last-rewrite'], makeDeps().deps)).toBe(1);
    expect(errs.join('\n')).toContain('No rewrite to undo');
  });

  test('env-source URL: rewrite REFUSED (an env var cannot be rewritten), exit 1', async () => {
    // No config file — the URL comes from GBRAIN_DATABASE_URL alone.
    process.env.GBRAIN_DATABASE_URL = POOLER_URL;
    const { deps } = makeDeps({ access: [netUnreachDiag()] });
    expect(await runDbRepair(['--yes', '--apply-rewrites'], deps)).toBe(1);
    expect(existsSync(configPath())).toBe(false); // nothing persisted
    expect(existsSync(undoFile())).toBe(false);
    const rows = readReceipts();
    expect(rows.filter((r) => r.outcome === 'applied').length).toBe(0);
    const refused = rows.filter((r) => r.outcome === 'refused');
    expect(refused.length).toBe(1);
    expect(refused[0].action).toBe('rewrite_to_session_pooler');
    expect(logs.join('\n')).toContain('env:GBRAIN_DATABASE_URL');
  });
});

describe('db-repair receipts + advisory lock', () => {
  test('receipts cap: 205 seeded diagnose rows + one write → file capped at 200, newest kept', async () => {
    const seeded: string[] = [];
    for (let i = 0; i < 205; i++) {
      seeded.push(JSON.stringify(receipt({ ts: FIXED_NOW - (205 - i) * 1000, action: `seed-${i}`, outcome: 'diagnose' })));
    }
    writeFileSync(receiptsPath(), seeded.join('\n') + '\n');
    writeReceipt(receipt({ ts: FIXED_NOW, action: 'cap-probe', outcome: 'diagnose' }));
    const rows = readReceipts();
    expect(rows.length).toBe(RECEIPTS_CAP);
    expect(rows[rows.length - 1].action).toBe('cap-probe');
    // Oldest rows fell off the front.
    expect(rows[0].action).toBe('seed-6');
  });

  test('receipts cap: a recent APPLIED row survives a 300-row diagnose flood (cooldown memory is never evicted)', async () => {
    // The exact eviction that would disarm the 24h rewrite cooldown: one
    // applied rewrite receipt, then an agent loop writing diagnose rows
    // every few minutes. The applied row must outlive the flat cap.
    writeFileSync(
      receiptsPath(),
      JSON.stringify(receipt({ ts: FIXED_NOW - 60_000, action: 'rewrite_to_session_pooler', outcome: 'applied' })) + '\n',
    );
    for (let i = 0; i < 300; i++) {
      writeReceipt(receipt({ ts: FIXED_NOW + i * 1000, action: `flood-${i}`, outcome: 'diagnose' }));
    }
    const rows = readReceipts();
    const applied = rows.filter((r) => r.outcome === 'applied');
    expect(applied.length).toBe(1);
    expect(applied[0].action).toBe('rewrite_to_session_pooler');
    // Diagnose rows still flat-capped.
    expect(rows.filter((r) => r.outcome === 'diagnose').length).toBe(RECEIPTS_CAP);
    // And the cooldown still fires off that surviving row.
    expect(rewriteCooldownBlocked('network_unreachable', 'rewrite_to_session_pooler', FIXED_NOW + 300_000)).toBe(true);
  });

  test('receipts cap: applied rows OLDER than the retention window are evicted normally', async () => {
    const stale = FIXED_NOW - 30 * 24 * 60 * 60 * 1000; // 30 days — past the window
    const seeded: string[] = [];
    for (let i = 0; i < 205; i++) {
      seeded.push(JSON.stringify(receipt({ ts: stale + i * 1000, action: `old-applied-${i}`, outcome: 'applied' })));
    }
    writeFileSync(receiptsPath(), seeded.join('\n') + '\n');
    writeReceipt(receipt({ ts: FIXED_NOW, action: 'cap-probe', outcome: 'diagnose' }));
    expect(readReceipts().length).toBe(RECEIPTS_CAP);
  });

  test('advisory lock held by a LIVE pid → exit 1 repair in progress', async () => {
    writeConfig({ engine: 'postgres', database_url: PLAIN_PG_URL });
    writeFileSync(lockFile(), JSON.stringify({ pid: process.pid, ts: FIXED_NOW }));
    expect(await runDbRepair([], makeDeps().deps)).toBe(1);
    expect(errs.join('\n')).toContain('repair in progress');
  });

  test('advisory lock held by a DEAD pid → repair proceeds', async () => {
    writeConfig({ engine: 'postgres', database_url: PLAIN_PG_URL });
    // A just-reaped child pid is affirmatively dead (ESRCH), unlike a made-up
    // number that could theoretically be recycled.
    const child = spawnSync('true');
    const deadPid = child.pid && child.pid > 0 ? child.pid : 999_999;
    writeFileSync(lockFile(), JSON.stringify({ pid: deadPid, ts: FIXED_NOW }));
    expect(await runDbRepair([], makeDeps({ access: [null], schema: [null] }).deps)).toBe(0);
    // Lock was taken over and released on the way out.
    expect(existsSync(lockFile())).toBe(false);
  });

  test('readReceipts: a torn line (kill mid-append) is skipped, valid rows on BOTH sides survive', () => {
    const lines = [
      JSON.stringify(receipt({ action: 'kept-1' })),
      JSON.stringify(receipt({ action: 'kept-2' })),
      '{"ts":123,', // torn mid-append — must not discard every OTHER receipt
      JSON.stringify(receipt({ action: 'kept-3' })),
    ];
    writeFileSync(receiptsPath(), lines.join('\n') + '\n');
    const rows = readReceipts();
    expect(rows.length).toBe(3);
    expect(rows.map((r) => r.action)).toEqual(['kept-1', 'kept-2', 'kept-3']);
  });
});

describe('db-repair undo — JSON envelope, reversibility, lock', () => {
  function seedUndoRecord(priorUrl: string): void {
    writeFileSync(undoFile(), JSON.stringify({ prior_url: priorUrl, ts: FIXED_NOW - HOUR, reason: 'network_unreachable' }));
  }

  test('--json undo emits ONE parseable envelope: applied includes undo_last_rewrite, fixed true, exit 0', async () => {
    writeConfig({ engine: 'postgres', database_url: SESSION_URL }); // the rewritten URL currently live
    seedUndoRecord(POOLER_URL);
    const { deps } = makeDeps(); // exhausted queue = restored URL probes healthy
    expect(await runDbRepair(['--yes', '--undo-last-rewrite', '--json'], deps)).toBe(0);

    const payload = JSON.parse(logs.join('\n'));
    expect(payload.schema_version).toBe(1);
    expect(payload.reason).toBe('undo');
    expect(payload.applied).toContain('undo_last_rewrite');
    expect(payload.fixed).toBe(true);
    expect(payload.remaining).toBeNull();
    // The envelope is redacted like every other surface.
    expect(logs.join('\n')).not.toContain(':pw@');
  });

  test('undo is reversible: the undo file now holds the URL config held BEFORE the undo, reason undo', async () => {
    writeConfig({ engine: 'postgres', database_url: SESSION_URL });
    seedUndoRecord(POOLER_URL);
    expect(await runDbRepair(['--yes', '--undo-last-rewrite'], makeDeps().deps)).toBe(0);

    expect(readConfig().database_url).toBe(POOLER_URL); // restored
    const undo = JSON.parse(readFileSync(undoFile(), 'utf-8'));
    expect(undo.prior_url).toBe(SESSION_URL); // the previously-rewritten URL
    expect(undo.reason).toBe('undo');
  });

  test('undo runs INSIDE the advisory lock: a live holder blocks it (exit 1, config untouched)', async () => {
    writeConfig({ engine: 'postgres', database_url: SESSION_URL });
    seedUndoRecord(POOLER_URL);
    writeFileSync(lockFile(), JSON.stringify({ pid: process.pid, ts: FIXED_NOW }));
    expect(await runDbRepair(['--yes', '--undo-last-rewrite'], makeDeps().deps)).toBe(1);
    expect(errs.join('\n')).toContain('repair in progress');
    expect(readConfig().database_url).toBe(SESSION_URL); // no rewrite happened
    expect(JSON.parse(readFileSync(undoFile(), 'utf-8')).prior_url).toBe(POOLER_URL); // record untouched
  });
});

describe('db-repair docker arm + healthy-path bonus + rewrite restart note', () => {
  test('conn_refused: the docker arm matches the container REAL port via deps.docker.hostPort', async () => {
    // Port drifted from the 5434 default (init reuse path) — isGbrainDockerUrl
    // is false, so only the hostPort probe can match it.
    const url = 'postgresql://postgres:x@localhost:59999/postgres';
    writeConfig({ engine: 'postgres', database_url: url });
    const { deps } = makeDeps({
      access: [connRefusedDiag(url)], // then healthy after docker start
      docker: {
        available: () => true,
        state: () => 'stopped' as const,
        start: () => true,
        hostPort: () => 59999,
      },
    });
    expect(await runDbRepair(['--yes'], deps)).toBe(0);
    const applied = readReceipts().filter((r) => r.outcome === 'applied');
    expect(applied.map((r) => r.action)).toContain('docker_start_gbrain-postgres');
    expect(applied[0].reason).toBe('conn_refused');
  });

  test('healthy path reports stale DB-plane config rows (report-only, still exit 0)', async () => {
    writeConfig({ engine: 'postgres', database_url: PLAIN_PG_URL });
    const executed: string[] = [];
    const fakeEngine = {
      executeRaw: async (sql: string) => {
        executed.push(sql);
        return [{ key: 'engine' }];
      },
    } as unknown as BrainEngine;
    const { deps } = makeDeps({
      withEngine: async (_config, fn) => fn(fakeEngine),
    });
    expect(await runDbRepair([], deps)).toBe(0);
    expect(logs.join('\n')).toContain('stale DB-plane config row');
    expect(logs.join('\n')).toContain('gbrain config unset');
    expect(executed.some((s) => s.includes('FROM config'))).toBe(true);
  });

  test('rewrite success prints the honest-scope restart note (long-lived pools keep the old URL)', async () => {
    writeConfig({ engine: 'postgres', database_url: PLAIN_PG_URL });
    // ssl_required → append ?sslmode=require (rewrite tier). Probe order:
    // initial (fails ssl) → candidate probe → post-persist re-probe.
    const { deps } = makeDeps({ access: [sslRequiredDiag(), null, null] });
    expect(await runDbRepair(['--yes', '--apply-rewrites'], deps)).toBe(0);
    expect(String(readConfig().database_url)).toBe(`${PLAIN_PG_URL}?sslmode=require`);
    expect(logs.join('\n')).toContain('restart them to pick up the new URL');
  });
});
