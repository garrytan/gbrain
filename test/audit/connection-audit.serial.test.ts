/**
 * test/audit/connection-audit.serial.test.ts — src/core/connection-audit.ts
 * (the ddl/bulk pool acquire/release/error JSONL trail).
 *
 * SERIAL (own bun process), for two reasons:
 *
 *   1. No dir seam. Unlike every audit-writer.ts consumer, connection-audit
 *      does NOT honor GBRAIN_AUDIT_DIR and takes no path param — it resolves
 *      gbrainPath('audit') (GBRAIN_HOME-keyed) ONCE into a module-level
 *      `_auditDirCache` with no reset export. The first write in a process
 *      freezes the dir for every later caller, so this file needs its own
 *      process with one GBRAIN_HOME for the whole run (tests below share the
 *      module-scope HOME and run in declaration order on purpose).
 *   2. The ISO-week drift-guard tests mock the process clock via bun:test
 *      setSystemTime (process-global), because logConnectionEvent computes
 *      its filename from `new Date()` with no injectable date.
 *
 * Tri-implementation drift guard: the ISO-week filename math exists three
 * times — the shared exported `computeIsoWeekFilename` (audit/audit-writer.ts),
 * connection-audit.ts's private `getIsoWeekFilename`, and a third private
 * copy in skillpack/audit.ts. The drift tests here freeze the clock at
 * year-boundary dates and assert connection-audit's private math routes the
 * write to exactly the file the shared export names (plus hard literal
 * expectations, so a matching drift in BOTH implementations still fails).
 *
 * NOTE (known, tracked by the orphan guard's test-only tier): tailRecentErrors
 * and setAuditEnabled currently have no production callers — the module header
 * describes doctor tail-reading the JSONL and PGLite engines no-oping via the
 * enabled flag, but only logConnectionEvent is wired (connection-manager.ts,
 * postgres-engine.ts). These tests pin the library surface so that wiring can
 * land against tested behavior.
 */

import { describe, test, expect, afterEach, setSystemTime } from 'bun:test';
import { appendFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  logConnectionEvent,
  setAuditEnabled,
  tailRecentErrors,
  type ConnectionEvent,
} from '../../src/core/connection-audit.ts';
import { computeIsoWeekFilename } from '../../src/core/audit/audit-writer.ts';
import { withEnv } from '../helpers/with-env.ts';

/** One home for the whole file — connection-audit freezes its dir on first use. */
const HOME = mkdtempSync(join(tmpdir(), 'gbrain-connaudit-home-'));
const AUDIT_DIR = join(HOME, '.gbrain', 'audit');

const env = { GBRAIN_HOME: HOME };

function fileFor(d: Date): string {
  return join(AUDIT_DIR, computeIsoWeekFilename('connection-events', d));
}

function readLines(path: string): ConnectionEvent[] {
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as ConnectionEvent];
      } catch {
        return [];
      }
    });
}

function lastLineRaw(path: string): string {
  const lines = readFileSync(path, 'utf-8').split('\n').filter(Boolean);
  return lines[lines.length - 1]!;
}

afterEach(() => {
  setSystemTime(); // always restore the real clock
  setAuditEnabled(true); // never leave the trail disabled for a later test
});

describe('connection-audit — tailRecentErrors on a cold home', () => {
  // MUST run first: after any logConnectionEvent the audit dir exists, and
  // this is the only chance to cover the dir-absent early return.
  test('[] when the audit dir does not exist yet', async () => {
    await withEnv(env, () => {
      expect(existsSync(AUDIT_DIR)).toBe(false);
      expect(tailRecentErrors()).toEqual([]);
    });
  });
});

describe('connection-audit — ISO-week filename (tri-implementation drift guard)', () => {
  // (date, expected literal) pairs pin BOTH implementations to ground truth:
  //   2024-01-01 — a Monday that opens its own ISO week (2024-W01)
  //   2026-01-05 — Jan 1 2026 is a Thursday, so Jan 5 is already W02
  //   2027-01-01 — belongs to ISO year 2026, week 53 (the year-boundary edge
  //                documented in audit-writer.ts)
  const CASES: Array<[string, string]> = [
    ['2024-01-01T12:00:00.000Z', 'connection-events-2024-W01.jsonl'],
    ['2026-01-05T12:00:00.000Z', 'connection-events-2026-W02.jsonl'],
    ['2027-01-01T12:00:00.000Z', 'connection-events-2026-W53.jsonl'],
  ];

  for (const [iso, expected] of CASES) {
    test(`${iso.slice(0, 10)} → ${expected} (shared export AND private write path agree)`, async () => {
      await withEnv(env, () => {
        const d = new Date(iso);
        // The shared implementation names the literal file...
        expect(computeIsoWeekFilename('connection-events', d)).toBe(expected);
        // ...and connection-audit's PRIVATE getIsoWeekFilename routes the
        // write to that exact file when the clock reads the same date.
        const path = join(AUDIT_DIR, expected);
        expect(existsSync(path)).toBe(false);
        try {
          setSystemTime(d);
          logConnectionEvent({ pool: 'ddl', op: 'acquire', caller: `drift.${iso.slice(0, 10)}` });
        } finally {
          setSystemTime();
        }
        expect(existsSync(path)).toBe(true);
        const rows = readLines(path);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.caller).toBe(`drift.${iso.slice(0, 10)}`);
      });
    });
  }
});

describe('connection-audit — logConnectionEvent host redaction', () => {
  const WEEK = new Date('2025-01-07T00:00:00.000Z'); // 2025-W02, untouched by other tests

  test('postgres(ql):// credentials never reach disk', async () => {
    await withEnv(env, () => {
      try {
        setSystemTime(WEEK);
        logConnectionEvent({
          pool: 'ddl',
          op: 'error',
          host: 'postgresql://dbuser:hunter2@db.example.com:5432/mydb',
          error: { message: 'boom' },
        });
        logConnectionEvent({ pool: 'bulk', op: 'error', host: 'postgres://u:p@h/db', error: { message: 'boom2' } });
      } finally {
        setSystemTime();
      }
      const path = fileFor(WEEK);
      const raw = readFileSync(path, 'utf-8');
      // Pin the real redaction (userinfo → ***, host/port/db preserved)...
      const rows = readLines(path);
      expect(rows[0]!.host).toBe('postgresql://***@db.example.com:5432/mydb');
      expect(rows[1]!.host).toBe('postgres://***@h/db');
      // ...and that no credential fragment survives anywhere in the file.
      expect(raw).not.toContain('hunter2');
      expect(raw).not.toContain('dbuser:');
      expect(raw).not.toContain('u:p@');
    });
  });

  test('non-URL host is fully masked (defensive <redacted-url>)', async () => {
    await withEnv(env, () => {
      try {
        setSystemTime(WEEK);
        logConnectionEvent({ pool: 'read', op: 'error', host: 'db.internal:5432', error: { message: 'x' } });
      } finally {
        setSystemTime();
      }
      const rows = readLines(fileFor(WEEK));
      expect(rows[rows.length - 1]!.host).toBe('<redacted-url>');
    });
  });
});

describe('connection-audit — ts stamping', () => {
  const T = new Date('2025-02-04T09:30:00.000Z'); // 2025-W06, untouched by other tests

  test('omitted ts is stamped with the current time', async () => {
    await withEnv(env, () => {
      try {
        setSystemTime(T);
        logConnectionEvent({ pool: 'read', op: 'acquire', caller: 'ts.omitted' });
      } finally {
        setSystemTime();
      }
      const rows = readLines(fileFor(T));
      expect(rows[rows.length - 1]!.ts).toBe('2025-02-04T09:30:00.000Z');
    });
  });

  test('an EXPLICIT undefined ts is still stamped (spread-order bug)', async () => {
    // ConnectionEvent.ts is optional, so `{ ts: maybeTs, ... }` with maybeTs
    // undefined is a legal call. The stamp must survive the `...event` spread:
    // `{ ts: stamp, ...event }` lets the explicit undefined overwrite the
    // stamp and JSON.stringify then DROPS the key — a ts-less audit row that
    // breaks readers keying on ts (readRecent-style cutoffs sort/parse it).
    await withEnv(env, () => {
      try {
        setSystemTime(T);
        logConnectionEvent({ ts: undefined, pool: 'read', op: 'acquire', caller: 'ts.explicit-undefined' });
      } finally {
        setSystemTime();
      }
      const rows = readLines(fileFor(T));
      const row = rows[rows.length - 1]!;
      expect(row.caller).toBe('ts.explicit-undefined');
      expect(row.ts).toBe('2025-02-04T09:30:00.000Z');
      // The key must exist on the serialized line at all.
      expect(lastLineRaw(fileFor(T))).toContain('"ts"');
    });
  });

  test('a caller-provided ts is preserved verbatim', async () => {
    await withEnv(env, () => {
      try {
        setSystemTime(T);
        logConnectionEvent({ ts: '2020-05-05T00:00:00.000Z', pool: 'single', op: 'release', caller: 'ts.provided' });
      } finally {
        setSystemTime();
      }
      const rows = readLines(fileFor(T));
      expect(rows[rows.length - 1]!.ts).toBe('2020-05-05T00:00:00.000Z');
    });
  });
});

describe('connection-audit — setAuditEnabled', () => {
  const T = new Date('2025-04-08T00:00:00.000Z'); // 2025-W15, untouched by other tests

  test('disabled → nothing is written; re-enabled → writes resume', async () => {
    await withEnv(env, () => {
      const path = fileFor(T);
      try {
        setSystemTime(T);
        setAuditEnabled(false);
        logConnectionEvent({ pool: 'ddl', op: 'error', caller: 'disabled.write', error: { message: 'nope' } });
        expect(existsSync(path)).toBe(false);
        setAuditEnabled(true);
        logConnectionEvent({ pool: 'ddl', op: 'acquire', caller: 'enabled.write' });
      } finally {
        setSystemTime();
        setAuditEnabled(true);
      }
      const rows = readLines(path);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.caller).toBe('enabled.write');
    });
  });
});

describe('connection-audit — tailRecentErrors', () => {
  test('[] when this week has no file (dir exists by now)', async () => {
    await withEnv(env, () => {
      const T = new Date('2025-06-03T12:00:00.000Z'); // 2025-W23, never written
      expect(existsSync(AUDIT_DIR)).toBe(true);
      try {
        setSystemTime(T);
        expect(existsSync(fileFor(T))).toBe(false);
        expect(tailRecentErrors()).toEqual([]);
      } finally {
        setSystemTime();
      }
    });
  });

  test('newest-first, op=error only, malformed lines skipped, limit honored', async () => {
    await withEnv(env, () => {
      const T = new Date('2025-10-07T00:00:00.000Z'); // 2025-W41, untouched by other tests
      try {
        setSystemTime(T);
        logConnectionEvent({ pool: 'ddl', op: 'error', error: { message: 'first' } });
        logConnectionEvent({ pool: 'ddl', op: 'acquire', caller: 'noise' }); // filtered out
        logConnectionEvent({ pool: 'bulk', op: 'error', error: { message: 'second' } });
        // Malformed rows in the MIDDLE of the scan window must be skipped
        // silently (the backwards scan crosses them before older errors).
        appendFileSync(fileFor(T), '{oops not json\n', 'utf-8');
        appendFileSync(fileFor(T), 'plain garbage line\n', 'utf-8');
        logConnectionEvent({ pool: 'read', op: 'error', error: { message: 'third' } });

        const all = tailRecentErrors(5);
        expect(all.map((e) => e.error?.message)).toEqual(['third', 'second', 'first']);
        expect(all.every((e) => e.op === 'error')).toBe(true);

        const limited = tailRecentErrors(2);
        expect(limited.map((e) => e.error?.message)).toEqual(['third', 'second']);
      } finally {
        setSystemTime();
      }
    });
  });
});
