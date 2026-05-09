/**
 * Tests for the v0.32 OIDC end-user identity admin surface in
 * src/commands/auth.ts:
 *
 *   gbrain auth grant <email> <tier>
 *   gbrain auth revoke-grant <email>
 *   gbrain auth list-grants
 *
 * Calls grantUser / revokeUserGrant / listUserGrants directly with a
 * PGLite-backed sql tagged-template wrapper. No subprocess shell-out:
 * the dispatcher path that opens a real postgres-js connection is
 * exercised in integration; here we want fast in-process coverage of
 * the SQL semantics, the email validator, the typo-loud tier check,
 * and the schema-aware list-grants fallback.
 *
 * PGLite setup mirrors test/oauth.test.ts. PGLITE_SCHEMA_SQL already
 * provisions oauth_user_grants (the migrate.ts agent's v46 has landed),
 * so the test fixture below relies on the canonical schema rather than
 * defining its own DDL - that keeps this file from drifting if the
 * v46 column shape changes upstream.
 */
import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { PGLITE_SCHEMA_SQL } from '../src/core/pglite-schema.ts';
import { grantUser, revokeUserGrant, listUserGrants } from '../src/commands/auth.ts';

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let db: PGlite;
let sql: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<any>;

beforeAll(async () => {
  db = new PGlite({ extensions: { vector, pg_trgm } });
  await db.exec(PGLITE_SCHEMA_SQL);

  sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.reduce(
      (acc, str, i) => acc + str + (i < values.length ? `$${i + 1}` : ''),
      '',
    );
    const result = await db.query(query, values as any[]);
    return result.rows;
  };
}, 30_000);

afterAll(async () => {
  if (db) await db.close();
}, 15_000);

beforeEach(async () => {
  // Clean slate between tests so granted_at ordering and uniqueness
  // assertions don't leak across cases.
  await db.exec('DELETE FROM oauth_user_grants');
});

// ---------------------------------------------------------------------------
// process.exit + console capture helpers
//
// The CLI functions exit on error rather than throw. We replace
// process.exit with a thrower so a "rejects with bad input" test gets
// a real promise rejection it can assert on, then capture console
// output so the assertion can also check the error text.
// ---------------------------------------------------------------------------

function withCapture<T>(fn: () => Promise<T>): Promise<{
  result?: T;
  exitCode?: number;
  stdout: string[];
  stderr: string[];
  threw?: unknown;
}> {
  return (async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    const origExit = process.exit;

    let exitCode: number | undefined;
    console.log = (...args: unknown[]) => {
      stdout.push(args.map((a) => String(a)).join(' '));
    };
    console.error = (...args: unknown[]) => {
      stderr.push(args.map((a) => String(a)).join(' '));
    };
    (process.exit as any) = (code?: number) => {
      exitCode = code;
      throw new Error('__exit__');
    };

    try {
      const result = await fn();
      return { result, exitCode, stdout, stderr };
    } catch (e: unknown) {
      if (e instanceof Error && e.message === '__exit__') {
        return { exitCode, stdout, stderr };
      }
      return { exitCode, stdout, stderr, threw: e };
    } finally {
      console.log = origLog;
      console.error = origErr;
      process.exit = origExit;
    }
  })();
}

// ---------------------------------------------------------------------------
// grant
// ---------------------------------------------------------------------------

describe('grantUser', () => {
  test('inserts a new row with normalized email + tier', async () => {
    const cap = await withCapture(() => grantUser('  Alice@Example.COM ', 'Work', sql));
    expect(cap.exitCode).toBeUndefined();
    expect(cap.stdout.join('\n')).toContain('Granted Work to alice@example.com');

    const rows = await sql`SELECT email, access_tier, revoked_at, granted_by FROM oauth_user_grants`;
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe('alice@example.com');
    expect(rows[0].access_tier).toBe('Work');
    expect(rows[0].revoked_at).toBeNull();
    // detectGrantedBy reads `git config user.email`; in CI it may fall back
    // to the literal 'cli'. Either is fine - we just want non-empty audit.
    expect(typeof rows[0].granted_by).toBe('string');
    expect(rows[0].granted_by.length).toBeGreaterThan(0);
  });

  test('re-grant overwrites tier and clears revoked_at', async () => {
    // First grant -> Family
    await withCapture(() => grantUser('bob@example.com', 'Family', sql));
    // Soft-revoke
    await withCapture(() => revokeUserGrant('bob@example.com', sql));
    let rows = await sql`SELECT access_tier, revoked_at FROM oauth_user_grants WHERE email = 'bob@example.com'`;
    expect(rows[0].access_tier).toBe('Family');
    expect(rows[0].revoked_at).not.toBeNull();

    // Re-grant -> Work, also un-revokes
    const cap = await withCapture(() => grantUser('bob@example.com', 'Work', sql));
    expect(cap.exitCode).toBeUndefined();

    rows = await sql`SELECT access_tier, revoked_at FROM oauth_user_grants WHERE email = 'bob@example.com'`;
    expect(rows).toHaveLength(1);
    expect(rows[0].access_tier).toBe('Work');
    expect(rows[0].revoked_at).toBeNull();
  });

  test('rejects malformed email', async () => {
    const cases = [
      'no-at-sign',
      '@no-local.com',
      'no-domain@',
      'no-tld@plain',
      'two@@example.com',
    ];
    for (const bad of cases) {
      const cap = await withCapture(() => grantUser(bad, 'Work', sql));
      expect(cap.exitCode).toBe(1);
      expect(cap.stderr.join('\n').toLowerCase()).toContain('invalid email');
    }

    // No rows persisted from rejected calls.
    const rows = await sql`SELECT count(*)::int as count FROM oauth_user_grants`;
    expect(rows[0].count).toBe(0);
  });

  test('rejects email longer than 254 chars', async () => {
    const longLocal = 'a'.repeat(250);
    const cap = await withCapture(() => grantUser(`${longLocal}@example.com`, 'Work', sql));
    expect(cap.exitCode).toBe(1);
    expect(cap.stderr.join('\n').toLowerCase()).toContain('254');
  });

  test('rejects invalid tier (typo-loud via parseAccessTier)', async () => {
    const cap = await withCapture(() => grantUser('typo@example.com', 'Wokr', sql));
    expect(cap.exitCode).toBe(1);
    // parseAccessTier throws InvalidAccessTierError, whose message lists
    // the allowed tiers - that's the typo-loud signal we want operators
    // to see at the CLI.
    expect(cap.stderr.join('\n')).toContain('Wokr');
    const rows = await sql`SELECT count(*)::int as count FROM oauth_user_grants`;
    expect(rows[0].count).toBe(0);
  });

  test('rejects empty email or empty tier (usage path)', async () => {
    const cap1 = await withCapture(() => grantUser('', 'Work', sql));
    expect(cap1.exitCode).toBe(1);
    const cap2 = await withCapture(() => grantUser('x@y.com', '', sql));
    expect(cap2.exitCode).toBe(1);
  });

  test('all four tiers persist round-trip', async () => {
    const tiers = ['None', 'Family', 'Work', 'Full'];
    for (const t of tiers) {
      const cap = await withCapture(() => grantUser(`${t.toLowerCase()}@example.com`, t, sql));
      expect(cap.exitCode).toBeUndefined();
    }
    const rows = await sql`SELECT email, access_tier FROM oauth_user_grants ORDER BY email`;
    expect(rows).toHaveLength(4);
    const got = rows.map((r: any) => `${r.email}:${r.access_tier}`).sort();
    expect(got).toEqual([
      'family@example.com:Family',
      'full@example.com:Full',
      'none@example.com:None',
      'work@example.com:Work',
    ].sort());
  });
});

// ---------------------------------------------------------------------------
// revoke-grant
// ---------------------------------------------------------------------------

describe('revokeUserGrant', () => {
  test('marks the row revoked_at = now', async () => {
    await withCapture(() => grantUser('carol@example.com', 'Full', sql));
    const before = Date.now();
    const cap = await withCapture(() => revokeUserGrant('CAROL@example.com  ', sql));
    expect(cap.exitCode).toBeUndefined();

    const rows = await sql`SELECT email, revoked_at FROM oauth_user_grants WHERE email = 'carol@example.com'`;
    expect(rows).toHaveLength(1);
    expect(rows[0].revoked_at).not.toBeNull();
    const revokedMs = new Date(rows[0].revoked_at as string).getTime();
    // Allow a generous window (PGLite's clock + JS clock can differ by
    // tens of ms under bun:test). The point is "now-ish, not 1970".
    expect(revokedMs).toBeGreaterThanOrEqual(before - 5_000);
    expect(revokedMs).toBeLessThanOrEqual(Date.now() + 5_000);

    // Output mentions the access_token retention caveat.
    const out = cap.stdout.join('\n');
    expect(out).toContain('Revoked grant for carol@example.com');
    expect(out).toContain('subject_email=carol@example.com');
    expect(out.toLowerCase()).toContain('expiry');
  });

  test('exits 1 with friendly message when email is unknown', async () => {
    const cap = await withCapture(() => revokeUserGrant('ghost@example.com', sql));
    expect(cap.exitCode).toBe(1);
    expect(cap.stderr.join('\n')).toContain('No active grant for ghost@example.com');
  });

  test('exits 1 on already-revoked email (no double-revoke noise)', async () => {
    await withCapture(() => grantUser('dave@example.com', 'Work', sql));
    const first = await withCapture(() => revokeUserGrant('dave@example.com', sql));
    expect(first.exitCode).toBeUndefined();

    const second = await withCapture(() => revokeUserGrant('dave@example.com', sql));
    expect(second.exitCode).toBe(1);
    expect(second.stderr.join('\n')).toContain('No active grant for dave@example.com');

    // The original revoked_at must NOT have moved on the no-op second call.
    const rows = await sql`SELECT revoked_at FROM oauth_user_grants WHERE email = 'dave@example.com'`;
    expect(rows).toHaveLength(1);
    expect(rows[0].revoked_at).not.toBeNull();
  });

  test('rejects empty email argument (usage path)', async () => {
    const cap = await withCapture(() => revokeUserGrant('', sql));
    expect(cap.exitCode).toBe(1);
    expect(cap.stderr.join('\n').toLowerCase()).toContain('usage');
  });
});

// ---------------------------------------------------------------------------
// list-grants
// ---------------------------------------------------------------------------

describe('listUserGrants', () => {
  test('prints friendly hint when oauth_user_grants table is missing', async () => {
    // Build a brain WITHOUT the oauth_user_grants table to exercise the
    // schema-aware fallback. PGLITE_SCHEMA_SQL already provisions the
    // table (the migrate.ts agent landed v46 there), so we drop it on a
    // throwaway PGLite instance rather than on the shared `db`. Doing
    // it on the shared db would break every following test in this file.
    const isolated = new PGlite({ extensions: { vector, pg_trgm } });
    try {
      await isolated.exec(PGLITE_SCHEMA_SQL);
      // Drop the table so listUserGrants's information_schema probe sees
      // 0 columns and falls into the friendly-hint branch. CASCADE in case
      // future schema versions hang FKs off it.
      await isolated.exec('DROP TABLE IF EXISTS oauth_user_grants CASCADE');
      // Sanity: oauth_user_grants really is gone.
      const probe = await isolated.query(
        `SELECT count(*)::int as count FROM information_schema.columns
           WHERE table_schema = current_schema() AND table_name = 'oauth_user_grants'`,
      );
      expect((probe.rows[0] as any).count).toBe(0);

      const isolatedSql = async (
        strings: TemplateStringsArray,
        ...values: unknown[]
      ) => {
        const query = strings.reduce(
          (acc, str, i) => acc + str + (i < values.length ? `$${i + 1}` : ''),
          '',
        );
        const result = await isolated.query(query, values as any[]);
        return result.rows as Record<string, unknown>[];
      };

      const cap = await withCapture(() => listUserGrants(isolatedSql));
      expect(cap.exitCode).toBeUndefined();
      expect(cap.stdout.join('\n')).toContain('No grants table on this brain');
      expect(cap.stdout.join('\n')).toContain('apply-migrations');
    } finally {
      await isolated.close();
    }
  });

  test('prints empty-state message when table exists but has no rows', async () => {
    const cap = await withCapture(() => listUserGrants(sql));
    expect(cap.exitCode).toBeUndefined();
    const out = cap.stdout.join('\n');
    expect(out).toContain('No user grants');
    // Hint mentions the grant subcommand so operators can self-onboard.
    expect(out).toContain('gbrain auth grant');
  });

  test('lists rows sorted by granted_at DESC with active/REVOKED status', async () => {
    // Seed three rows; revoke one. The DESC ordering means the most
    // recent grant (eve) should appear first.
    await withCapture(() => grantUser('alice@example.com', 'Family', sql));
    // Force a tiny gap so granted_at ORDER BY is deterministic.
    await new Promise((r) => setTimeout(r, 10));
    await withCapture(() => grantUser('bob@example.com', 'Work', sql));
    await new Promise((r) => setTimeout(r, 10));
    await withCapture(() => grantUser('eve@example.com', 'Full', sql));

    await withCapture(() => revokeUserGrant('bob@example.com', sql));

    const cap = await withCapture(() => listUserGrants(sql));
    expect(cap.exitCode).toBeUndefined();
    const out = cap.stdout.join('\n');

    // Header + ASCII separator (no box-drawing chars).
    expect(out).toContain('Email');
    expect(out).toContain('Tier');
    expect(out).toContain('Granted At');
    expect(out).toContain('Granted By');
    expect(out).toContain('Status');
    // Spec: ASCII '-' separator only.
    expect(out).toContain('-'.repeat(20));
    // Hard guard against accidental unicode box-drawing.
    expect(out).not.toContain('─'); // BOX DRAWINGS LIGHT HORIZONTAL - the listClients
    // older surface used this char; the spec for list-grants explicitly mandates ASCII '-'.

    // All three rows present.
    expect(out).toContain('alice@example.com');
    expect(out).toContain('bob@example.com');
    expect(out).toContain('eve@example.com');

    // Status column reflects revoked_at.
    const bobLine = out.split('\n').find((l) => l.includes('bob@example.com'))!;
    expect(bobLine).toContain('REVOKED');
    const aliceLine = out.split('\n').find((l) => l.includes('alice@example.com'))!;
    expect(aliceLine).toContain('active');

    // DESC ordering: eve appears before bob appears before alice in the body.
    const eveIdx = out.indexOf('eve@example.com');
    const bobIdx = out.indexOf('bob@example.com');
    const aliceIdx = out.indexOf('alice@example.com');
    expect(eveIdx).toBeLessThan(bobIdx);
    expect(bobIdx).toBeLessThan(aliceIdx);
  });
});
