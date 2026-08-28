/**
 * Classified `connection` check (db-availability 2c / 2c-bis), driven through
 * the buildChecks seam (classifiedConnectionCheck itself is module-private):
 *
 *   - 2c-bis dead-DB lane: engine=null + a captured connectError synthesizes
 *     the ONE classified fail shape (name 'connection', details.reason,
 *     details.fix_hint naming `gbrain db-repair`) so
 *     checks[name=="connection"] exists in every failure shape.
 *   - 2c live-engine lane: an engine whose getStats rejects produces the
 *     SAME classified shape, and the URL-only pgbouncer_prepare check (hoisted
 *     ABOVE the connection check) still lands before it.
 *   - db_repair_recurrence runs in the dead-DB lane too (engine-free
 *     receipts read): 3x same-reason applied rows warn; cross-brain rows
 *     never sum toward one threshold.
 *
 * GBRAIN_HOME points at a fresh temp dir per test (receipts + config.json
 * hermetic); `--scope=brain` keeps the filesystem skill walk out of the run.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildChecks, type Check } from '../src/commands/doctor.ts';
import { writeReceipt, type RepairReceipt } from '../src/core/db-repair-receipts.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const NOW = Date.now();
const DAY = 24 * 3600 * 1000;

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  prevHome = process.env.GBRAIN_HOME;
  home = mkdtempSync(join(tmpdir(), 'gbrain-doctor-conn-'));
  process.env.GBRAIN_HOME = home;
  mkdirSync(join(home, '.gbrain'), { recursive: true });
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

function connRefusedError(): Error {
  return new Error('connect ECONNREFUSED 127.0.0.1:5432');
}

function byName(checks: Check[], name: string): Check | undefined {
  return checks.find((c) => c.name === name);
}

function seedReceipt(overrides: Partial<RepairReceipt>): void {
  writeReceipt({
    ts: NOW - DAY,
    brain_id: 'host',
    reason: 'conn_refused',
    action: 'bounded_reconnect',
    outcome: 'applied',
    ...overrides,
  });
}

describe('dead-DB synthesized connection check (2c-bis)', () => {
  test('null engine + connectError → classified fail with reason + db-repair fix hint', async () => {
    const checks = await buildChecks(null, ['--scope=brain'], 'config-file', connRefusedError());
    const conn = byName(checks, 'connection');
    expect(conn).toBeDefined();
    expect(conn!.status).toBe('fail');
    const details = conn!.details as { reason: string; transient: boolean; fix_hint: string };
    expect(details.reason).toBe('conn_refused');
    expect(details.fix_hint).toContain('gbrain db-repair');
    // Redaction posture: the classified message is safe copy, not raw driver text.
    expect(typeof conn!.message).toBe('string');
  }, 60_000);

  test('db_repair_recurrence runs in the dead-DB lane: 3x same-reason applied rows warn', async () => {
    seedReceipt({ ts: NOW - 1 * DAY });
    seedReceipt({ ts: NOW - 2 * DAY });
    seedReceipt({ ts: NOW - 3 * DAY });
    const checks = await buildChecks(null, ['--scope=brain'], 'config-file', connRefusedError());
    const rec = byName(checks, 'db_repair_recurrence');
    expect(rec).toBeDefined();
    expect(rec!.status).toBe('warn');
    expect(rec!.message).toContain('conn_refused');
  }, 60_000);

  test('cross-brain rows (2 + 1 same reason) never sum toward the threshold → no warn', async () => {
    seedReceipt({ brain_id: 'host' });
    seedReceipt({ brain_id: 'host' });
    seedReceipt({ brain_id: 'team-brain' });
    const checks = await buildChecks(null, ['--scope=brain'], 'config-file', connRefusedError());
    const rec = byName(checks, 'db_repair_recurrence');
    // Applied rows exist, so the check reports — but 'ok', never 'warn'.
    expect(rec).toBeDefined();
    expect(rec!.status).toBe('ok');
  }, 60_000);
});

describe('live-engine connection catch (2c)', () => {
  /** Every method resolves benign-empty EXCEPT getStats, which rejects with
   *  the classified connect error — the connection check's catch is the
   *  target, not the best-effort checks that run before it. */
  function statsRejectingEngine(err: Error): BrainEngine {
    return new Proxy({}, {
      get(_t, prop) {
        if (prop === 'kind') return 'postgres';
        if (prop === 'then') return undefined; // not a thenable
        if (prop === 'getStats') return () => Promise.reject(err);
        if (prop === 'getConfig') return async () => null;
        return async () => [];
      },
    }) as unknown as BrainEngine;
  }

  test('getStats rejecting ECONNREFUSED → same classified shape; pgbouncer_prepare (URL-only) ran before it', async () => {
    // A config-file URL on the PgBouncer transaction port makes the URL-only
    // pgbouncer_prepare check fire (prepare auto-disables on 6543 → 'ok').
    writeFileSync(
      join(home, '.gbrain', 'config.json'),
      JSON.stringify({ engine: 'postgres', database_url: 'postgresql://u:p@localhost:6543/db' }), /* allow-pg-url-literal */
    );
    const err = connRefusedError();
    const checks = await buildChecks(statsRejectingEngine(err), ['--scope=brain']);
    expect(Array.isArray(checks)).toBe(true);

    const conn = byName(checks, 'connection');
    expect(conn).toBeDefined();
    expect(conn!.status).toBe('fail');
    const details = conn!.details as { reason: string; fix_hint: string };
    expect(details.reason).toBe('conn_refused');
    expect(details.fix_hint).toContain('gbrain db-repair');

    // The URL-only lane is hoisted ABOVE the connection probe so it survives
    // a dead DB — assert both presence and ordering.
    const pgb = byName(checks, 'pgbouncer_prepare');
    expect(pgb).toBeDefined();
    expect(checks.indexOf(pgb!)).toBeLessThan(checks.indexOf(conn!));
  }, 60_000);
});
