import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import {
  isSupabasePoolerUrl,
  deriveDirectUrl,
  deriveSessionPoolerUrl,
  normalizeDirectUrl,
  readKillSwitchEnv,
  isNetworkUnreachableError,
  resolveDirectPoolSize,
  ConnectionManager,
  DEFAULT_DIRECT_POOL_SIZE,
} from '../src/core/connection-manager.ts';

describe('isSupabasePoolerUrl', () => {
  test('detects port 6543', () => {
    expect(isSupabasePoolerUrl('postgresql://u:p@host:6543/db')).toBe(true);
  });

  test('detects pooler.supabase.com hostname', () => {
    expect(
      isSupabasePoolerUrl('postgresql://u:p@aws-0-us-east-1.pooler.supabase.com:5432/db')
    ).toBe(true);
  });

  test('rejects direct supabase host', () => {
    expect(
      isSupabasePoolerUrl('postgresql://u:p@db.abc.supabase.co:5432/postgres')
    ).toBe(false);
  });

  test('rejects self-hosted on standard port', () => {
    expect(isSupabasePoolerUrl('postgresql://u:p@localhost:5432/gbrain_test')).toBe(false);
  });

  test('handles malformed URL gracefully', () => {
    expect(isSupabasePoolerUrl('not a url')).toBe(false);
  });
});

describe('deriveDirectUrl', () => {
  test('swaps pooler hostname + port for known shape', () => {
    const direct = deriveDirectUrl(
      'postgresql://postgres.abcxyz:secret@aws-0-us-east-1.pooler.supabase.com:6543/postgres'
    );
    expect(direct).toBeTruthy();
    expect(direct).toContain('db.abcxyz.supabase.co:5432');
    expect(direct).toContain(':secret@'); // creds preserved
  });

  test('strips .<project-ref> suffix from username when going pooler→direct', () => {
    // Supabase direct connections require bare `postgres`; the `postgres.<ref>`
    // form is pooler-only (Supavisor uses the suffix for tenant routing).
    // Without the strip, direct auth fails with "password authentication
    // failed for user postgres.<ref>" even with the correct password.
    const direct = deriveDirectUrl(
      'postgresql://postgres.abcxyz:secret@aws-0-us-east-1.pooler.supabase.com:6543/postgres'
    );
    expect(direct).toContain('postgres:secret@'); // bare username
    expect(direct).not.toContain('postgres.abcxyz:secret@'); // no pooler suffix
  });

  test('falls back to port-only swap when project-ref unparseable', () => {
    const direct = deriveDirectUrl(
      'postgresql://customuser:secret@some.pooler.supabase.com:6543/db'
    );
    expect(direct).toBeTruthy();
    expect(direct).toContain(':5432');
    expect(direct).toContain('some.pooler.supabase.com'); // host preserved
    expect(direct).toContain('customuser:secret@'); // non-pooler username preserved
  });

  test('returns null for non-pooler URL', () => {
    expect(deriveDirectUrl('postgresql://u:p@localhost:5432/db')).toBeNull();
  });

  test('preserves query string', () => {
    const direct = deriveDirectUrl(
      'postgresql://postgres.ref:p@aws.pooler.supabase.com:6543/db?prepare=false'
    );
    expect(direct).toContain('?prepare=false');
  });
});

describe('normalizeDirectUrl', () => {
  test('normalizes a transaction-pooler (6543) override to the real direct host', () => {
    const direct = normalizeDirectUrl(
      'postgresql://postgres.abcxyz:p@aws-0-us-west-2.pooler.supabase.com:6543/postgres',
      'postgresql://postgres.abcxyz:p@aws-0-us-west-2.pooler.supabase.com:6543/postgres',
    );
    expect(direct).toBe('postgresql://postgres:p@db.abcxyz.supabase.co:5432/postgres');
  });

  test('keeps a non-pooler direct override', () => {
    const direct = normalizeDirectUrl(
      'postgresql://postgres.abc:p@aws.pooler.supabase.com:6543/db',
      'postgresql://u:p@custom-direct.example.com:5432/db',
    );
    expect(direct).toBe('postgresql://u:p@custom-direct.example.com:5432/db');
  });

  test('keeps a session-mode pooler override (pooler host, port 5432)', () => {
    const sessionUrl = 'postgresql://postgres.abc:p@aws.pooler.supabase.com:5432/db';
    const direct = normalizeDirectUrl(
      'postgresql://postgres.abc:p@aws.pooler.supabase.com:6543/db',
      sessionUrl,
    );
    expect(direct).toBe(sessionUrl);
  });

  test('no override: derives from the primary as before', () => {
    const direct = normalizeDirectUrl(
      'postgresql://postgres.abc:p@aws.pooler.supabase.com:6543/db',
    );
    expect(direct).toContain('db.abc.supabase.co:5432');
  });

  test('no override, non-Supabase primary: null', () => {
    expect(normalizeDirectUrl('postgresql://u:p@localhost:5432/db')).toBeNull();
  });
});

describe('readKillSwitchEnv', () => {
  let original: string | undefined;
  beforeEach(() => { original = process.env.GBRAIN_DISABLE_DIRECT_POOL; });
  afterEach(() => {
    if (original === undefined) delete process.env.GBRAIN_DISABLE_DIRECT_POOL;
    else process.env.GBRAIN_DISABLE_DIRECT_POOL = original;
  });

  test('false when unset', () => {
    delete process.env.GBRAIN_DISABLE_DIRECT_POOL;
    expect(readKillSwitchEnv()).toBe(false);
  });

  test('true when "1"', () => {
    process.env.GBRAIN_DISABLE_DIRECT_POOL = '1';
    expect(readKillSwitchEnv()).toBe(true);
  });

  test('true when "true"', () => {
    process.env.GBRAIN_DISABLE_DIRECT_POOL = 'true';
    expect(readKillSwitchEnv()).toBe(true);
  });

  test('false for any other value', () => {
    process.env.GBRAIN_DISABLE_DIRECT_POOL = '0';
    expect(readKillSwitchEnv()).toBe(false);
    process.env.GBRAIN_DISABLE_DIRECT_POOL = 'false';
    expect(readKillSwitchEnv()).toBe(false);
  });
});

describe('resolveDirectPoolSize', () => {
  let original: string | undefined;
  beforeEach(() => { original = process.env.GBRAIN_DIRECT_POOL_SIZE; });
  afterEach(() => {
    if (original === undefined) delete process.env.GBRAIN_DIRECT_POOL_SIZE;
    else process.env.GBRAIN_DIRECT_POOL_SIZE = original;
  });

  test('default to 3', () => {
    delete process.env.GBRAIN_DIRECT_POOL_SIZE;
    expect(resolveDirectPoolSize()).toBe(DEFAULT_DIRECT_POOL_SIZE);
    expect(DEFAULT_DIRECT_POOL_SIZE).toBe(3);
  });

  test('explicit overrides env', () => {
    process.env.GBRAIN_DIRECT_POOL_SIZE = '5';
    expect(resolveDirectPoolSize(7)).toBe(7);
  });

  test('env overrides default', () => {
    process.env.GBRAIN_DIRECT_POOL_SIZE = '5';
    expect(resolveDirectPoolSize()).toBe(5);
  });

  test('rejects invalid env values', () => {
    process.env.GBRAIN_DIRECT_POOL_SIZE = 'abc';
    expect(resolveDirectPoolSize()).toBe(DEFAULT_DIRECT_POOL_SIZE);
    process.env.GBRAIN_DIRECT_POOL_SIZE = '0';
    expect(resolveDirectPoolSize()).toBe(DEFAULT_DIRECT_POOL_SIZE);
    process.env.GBRAIN_DIRECT_POOL_SIZE = '999';
    expect(resolveDirectPoolSize()).toBe(DEFAULT_DIRECT_POOL_SIZE);
  });
});

describe('ConnectionManager — describeMode + dual-pool routing', () => {
  let originalKillSwitch: string | undefined;
  let originalDirectUrl: string | undefined;
  beforeEach(() => {
    originalKillSwitch = process.env.GBRAIN_DISABLE_DIRECT_POOL;
    originalDirectUrl = process.env.GBRAIN_DIRECT_DATABASE_URL;
    delete process.env.GBRAIN_DISABLE_DIRECT_POOL;
    delete process.env.GBRAIN_DIRECT_DATABASE_URL;
  });
  afterEach(() => {
    if (originalKillSwitch === undefined) delete process.env.GBRAIN_DISABLE_DIRECT_POOL;
    else process.env.GBRAIN_DISABLE_DIRECT_POOL = originalKillSwitch;
    if (originalDirectUrl === undefined) delete process.env.GBRAIN_DIRECT_DATABASE_URL;
    else process.env.GBRAIN_DIRECT_DATABASE_URL = originalDirectUrl;
  });

  test('non-Supabase URL → single mode', () => {
    const cm = new ConnectionManager({ url: 'postgresql://u:p@localhost:5432/db' });
    expect(cm.isSupabase()).toBe(false);
    expect(cm.isDualPoolActive()).toBe(false);
    expect(cm.describeMode().mode).toBe('single (non-supabase)');
  });

  test('Supabase pooler URL → dual mode (without kill-switch)', () => {
    const cm = new ConnectionManager({
      url: 'postgresql://postgres.abc:p@aws.pooler.supabase.com:6543/db',
    });
    expect(cm.isSupabase()).toBe(true);
    expect(cm.isDualPoolActive()).toBe(true);
    expect(cm.describeMode().mode).toBe('split');
    expect(cm.describeMode().direct_host).toContain('db.abc.supabase.co:5432');
  });

  test('kill-switch active → single mode (kill-switch)', () => {
    process.env.GBRAIN_DISABLE_DIRECT_POOL = '1';
    const cm = new ConnectionManager({
      url: 'postgresql://postgres.abc:p@aws.pooler.supabase.com:6543/db',
    });
    expect(cm.isSupabase()).toBe(true);
    expect(cm.isKillSwitchActive()).toBe(true);
    expect(cm.isDualPoolActive()).toBe(false);
    expect(cm.describeMode().mode).toBe('single (kill-switch)');
  });

  test('explicit directUrl override wins', () => {
    const cm = new ConnectionManager({
      url: 'postgresql://postgres.abc:p@aws.pooler.supabase.com:6543/db',
      directUrl: 'postgresql://u:p@custom-direct.example.com:5432/db',
    });
    expect(cm.resolveDirectUrl()).toContain('custom-direct.example.com');
  });

  test('explicit transaction-pooler directUrl override is normalized to direct host', () => {
    const cm = new ConnectionManager({
      url: 'postgresql://postgres.abc:p@aws.pooler.supabase.com:6543/db',
      directUrl: 'postgresql://postgres.abc:p@aws.pooler.supabase.com:6543/db',
    });
    expect(cm.resolveDirectUrl()).toContain('db.abc.supabase.co:5432');
    expect(cm.resolveDirectUrl()).not.toContain(':6543');
  });

  test('env transaction-pooler directUrl override is normalized to direct host', () => {
    process.env.GBRAIN_DIRECT_DATABASE_URL =
      'postgresql://postgres.abc:p@aws.pooler.supabase.com:6543/db';
    const cm = new ConnectionManager({
      url: 'postgresql://postgres.abc:p@aws.pooler.supabase.com:6543/db',
    });
    expect(cm.resolveDirectUrl()).toContain('db.abc.supabase.co:5432');
    expect(cm.resolveDirectUrl()).not.toContain(':6543');
  });

  test('host string contains creds neither in describeMode nor resolveDirectUrl logging', () => {
    const cm = new ConnectionManager({
      url: 'postgresql://postgres.abc:secret@aws.pooler.supabase.com:6543/db',
    });
    const desc = cm.describeMode();
    expect(desc.direct_host ?? '').not.toContain('secret');
  });
});

describe('ConnectionManager — parent inheritance (A2)', () => {
  test('child inherits kill-switch from parent', () => {
    const original = process.env.GBRAIN_DISABLE_DIRECT_POOL;
    try {
      process.env.GBRAIN_DISABLE_DIRECT_POOL = '1';
      const parent = new ConnectionManager({
        url: 'postgresql://postgres.abc:p@aws.pooler.supabase.com:6543/db',
      });
      // Child constructed AFTER env reset — parent's snapshot is what matters.
      delete process.env.GBRAIN_DISABLE_DIRECT_POOL;
      const child = new ConnectionManager({
        url: 'postgresql://postgres.abc:p@aws.pooler.supabase.com:6543/db',
        parent,
      });
      expect(child.isKillSwitchActive()).toBe(true);
      expect(child.isDualPoolActive()).toBe(false);
    } finally {
      if (original === undefined) delete process.env.GBRAIN_DISABLE_DIRECT_POOL;
      else process.env.GBRAIN_DISABLE_DIRECT_POOL = original;
    }
  });

  test('child without parent reads env at construction', () => {
    const original = process.env.GBRAIN_DISABLE_DIRECT_POOL;
    try {
      delete process.env.GBRAIN_DISABLE_DIRECT_POOL;
      const cm = new ConnectionManager({
        url: 'postgresql://postgres.abc:p@aws.pooler.supabase.com:6543/db',
      });
      expect(cm.isKillSwitchActive()).toBe(false);
      // Mutating env after construction does NOT change the manager's state.
      process.env.GBRAIN_DISABLE_DIRECT_POOL = '1';
      expect(cm.isKillSwitchActive()).toBe(false); // snapshot semantics
    } finally {
      if (original === undefined) delete process.env.GBRAIN_DISABLE_DIRECT_POOL;
      else process.env.GBRAIN_DISABLE_DIRECT_POOL = original;
    }
  });
});

describe('isNetworkUnreachableError (#1641)', () => {
  test('classifies network codes as unreachable', () => {
    for (const code of ['ENOTFOUND', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT', 'CONNECT_TIMEOUT']) {
      const err = Object.assign(new Error('connect failed'), { code });
      expect(isNetworkUnreachableError(err)).toBe(true);
    }
  });

  test('classifies by message when code absent', () => {
    expect(isNetworkUnreachableError(new Error('getaddrinfo ENOTFOUND db.abc.supabase.co'))).toBe(true);
  });

  test('auth/SQL errors are NOT unreachable', () => {
    expect(isNetworkUnreachableError(new Error('password authentication failed for user "postgres"'))).toBe(false);
    expect(isNetworkUnreachableError(new Error('syntax error at or near "SELEC"'))).toBe(false);
    expect(isNetworkUnreachableError(null)).toBe(false);
  });
});

describe('ConnectionManager — direct-pool fallback on unreachable host (#1641)', () => {
  let originalKillSwitch: string | undefined;
  let originalError: typeof console.error;
  let errLines: string[];
  beforeEach(() => {
    originalKillSwitch = process.env.GBRAIN_DISABLE_DIRECT_POOL;
    delete process.env.GBRAIN_DISABLE_DIRECT_POOL;
    originalError = console.error;
    errLines = [];
    console.error = (...args: unknown[]) => { errLines.push(args.join(' ')); };
  });
  afterEach(() => {
    console.error = originalError;
    if (originalKillSwitch === undefined) delete process.env.GBRAIN_DISABLE_DIRECT_POOL;
    else process.env.GBRAIN_DISABLE_DIRECT_POOL = originalKillSwitch;
  });

  test('ddl() falls back to the read pool when the direct host is unreachable', async () => {
    const cm = new ConnectionManager({
      url: 'postgresql://postgres.abc:p@aws.pooler.supabase.com:6543/db',
      // 127.0.0.1:9 (discard) → instant ECONNREFUSED, the IPv4-only-network shape.
      directUrl: 'postgresql://postgres:p@127.0.0.1:9/db',
    });
    const fakeReadPool = {} as ReturnType<typeof ConnectionManager.prototype.read>;
    cm.setReadPool(fakeReadPool);
    expect(cm.isDualPoolActive()).toBe(true);

    const pool = await cm.ddl(); // without the fix this throws ECONNREFUSED
    expect(pool).toBe(fakeReadPool);
    // Self-activating kill-switch: subsequent calls skip the direct pool.
    expect(cm.isKillSwitchActive()).toBe(true);
    expect(cm.isDualPoolActive()).toBe(false);
    expect(cm.describeMode().mode).toBe('single (kill-switch)');
    // One stderr line mentioning the power-user override.
    const warning = errLines.filter(l => l.includes('GBRAIN_DIRECT_DATABASE_URL'));
    expect(warning.length).toBe(1);

    const again = await cm.ddl();
    expect(again).toBe(fakeReadPool);
    expect(errLines.filter(l => l.includes('GBRAIN_DIRECT_DATABASE_URL')).length).toBe(1);
  }, 20000);
});

// ─────────────────────────────────────────────────────────────────
// #1915 — session-pooler retry before the read-pool kill-switch.
//
// On IPv6-less networks (Railway, most home ISPs) the auto-derived
// db.<ref>.supabase.co direct host is unreachable, and pre-fix the #1641
// fallback dropped ALL DDL onto the TRANSACTION pooler — whose ~8s
// statement_timeout killed cold-start migrations (init retry loops). The
// session pooler (same host, port 5432) is IPv4-reachable and honors the
// direct pool's startup-parameter timeouts, so it's tried once first.
// ─────────────────────────────────────────────────────────────────

describe('deriveSessionPoolerUrl (#1915)', () => {
  test('transaction pooler → session pooler: same host, port 5432, KEEPS postgres.<ref> user', () => {
    const s = deriveSessionPoolerUrl(
      'postgresql://postgres.abcxyz:secret@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require',
    );
    // The tenant suffix is REQUIRED on the pooler (Supavisor routing) — unlike
    // deriveDirectUrl, the user must NOT be stripped to bare `postgres`.
    expect(s).toBe(
      'postgresql://postgres.abcxyz:secret@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require',
    );
  });

  test('null for non-pooler hosts, already-session URLs, and junk', () => {
    // Direct host: nothing to derive.
    expect(deriveSessionPoolerUrl('postgresql://u:p@db.abc.supabase.co:5432/postgres')).toBeNull();
    // Already session mode (pooler host, 5432): no-op.
    expect(deriveSessionPoolerUrl('postgresql://postgres.abc:p@aws.pooler.supabase.com:5432/db')).toBeNull();
    // 6543 on a non-pooler host: 5432 there is NOT known to be a session pooler.
    expect(deriveSessionPoolerUrl('postgresql://u:p@localhost:6543/db')).toBeNull();
    expect(deriveSessionPoolerUrl('not a url')).toBeNull();
  });
});

describe('ConnectionManager — session-pooler retry on unreachable direct host (#1915)', () => {
  let originalKillSwitch: string | undefined;
  let originalError: typeof console.error;
  let errLines: string[];
  beforeEach(() => {
    originalKillSwitch = process.env.GBRAIN_DISABLE_DIRECT_POOL;
    delete process.env.GBRAIN_DISABLE_DIRECT_POOL;
    originalError = console.error;
    errLines = [];
    console.error = (...args: unknown[]) => { errLines.push(args.join(' ')); };
  });
  afterEach(() => {
    console.error = originalError;
    if (originalKillSwitch === undefined) delete process.env.GBRAIN_DISABLE_DIRECT_POOL;
    else process.env.GBRAIN_DISABLE_DIRECT_POOL = originalKillSwitch;
  });

  const POOLER_URL = 'postgresql://postgres.abc:p@aws-0-us-east-1.pooler.supabase.com:6543/db';
  type Pool = ReturnType<typeof ConnectionManager.prototype.read>;
  const unreachable = () =>
    Object.assign(new Error('getaddrinfo ENOTFOUND db.abc.supabase.co'), { code: 'ENOTFOUND' });

  test('auto-derived direct unreachable → retries the session pooler, keeps dual-pool active', async () => {
    const cm = new ConnectionManager({ url: POOLER_URL }); // no override → auto-derived
    const fakeReadPool = {} as Pool;
    cm.setReadPool(fakeReadPool);
    const fakeSessionPool = { __session: true } as unknown as Pool;

    const attempts: string[] = [];
    // Instance-shadow the private init so no real sockets are opened. The
    // manager re-reads this._directUrl per attempt — that's the retry order pin.
    (cm as unknown as { initDirectPool: () => Promise<Pool> }).initDirectPool =
      async function (this: { _directUrl: string }) {
        attempts.push(this._directUrl);
        if (attempts.length === 1) throw unreachable();
        return fakeSessionPool;
      };

    const pool = await cm.ddl();
    expect(pool).toBe(fakeSessionPool);
    expect(attempts.length).toBe(2);
    expect(attempts[0]).toContain('db.abc.supabase.co:5432'); // direct first
    expect(attempts[1]).toContain('aws-0-us-east-1.pooler.supabase.com:5432'); // then session pooler
    // NOT the #1641 kill-switch: DDL still runs on a long-timeout pool.
    expect(cm.isKillSwitchActive()).toBe(false);
    expect(cm.isDualPoolActive()).toBe(true);
    expect(cm.describeMode().mode).toBe('split');
    expect(cm.describeMode().direct_host).toContain('pooler.supabase.com:5432');
    // One informational stderr line, no re-init on later calls.
    expect(errLines.filter(l => l.toLowerCase().includes('session pooler')).length).toBe(1);
    expect(await cm.ddl()).toBe(fakeSessionPool);
    expect(attempts.length).toBe(2);
  }, 20000);

  test('concurrent callers of a rejected direct init share the session-pooler single-flight (no premature kill-switch)', async () => {
    const cm = new ConnectionManager({ url: POOLER_URL }); // no override → auto-derived
    const fakeReadPool = {} as Pool;
    cm.setReadPool(fakeReadPool);
    const fakeSessionPool = { __session: true } as unknown as Pool;

    const attempts: string[] = [];
    let releaseSession!: (p: Pool) => void;
    const sessionGate = new Promise<Pool>(res => { releaseSession = res; });
    (cm as unknown as { initDirectPool: () => Promise<Pool> }).initDirectPool =
      async function (this: { _directUrl: string }) {
        attempts.push(this._directUrl);
        if (attempts.length === 1) throw unreachable();
        // Session attempt stays in flight until the test releases it, so the
        // second caller resumes while the retry is pending — the race window
        // where caller 1 has already mutated _directUrl to the session URL.
        return sessionGate;
      };

    // Both callers await the SAME rejected _directInit; caller 1 mutates
    // _directUrl before caller 2's continuation runs. Pre-fix, caller 2's
    // `sessionUrl !== this._directUrl` guard saw them equal, skipped the
    // in-flight _sessionInit, and tripped the read-pool kill-switch.
    const p1 = cm.ddl();
    const p2 = cm.ddl();
    await new Promise(res => setTimeout(res, 10)); // let both reach the retry logic
    releaseSession(fakeSessionPool);
    const [pool1, pool2] = await Promise.all([p1, p2]);
    expect(pool1).toBe(fakeSessionPool);
    expect(pool2).toBe(fakeSessionPool); // pre-fix: fakeReadPool + kill-switch
    expect(attempts.length).toBe(2); // direct once, session once — single-flight held
    expect(cm.isKillSwitchActive()).toBe(false);
    expect(cm.isDualPoolActive()).toBe(true);
    expect(errLines.filter(l => l.toLowerCase().includes('session pooler')).length).toBe(1);
    expect(errLines.filter(l => l.includes('falling back to the pooler')).length).toBe(0);
  }, 20000);

  test('direct AND session pooler unreachable → #1641 read-pool fallback (kill-switch)', async () => {
    const cm = new ConnectionManager({ url: POOLER_URL });
    const fakeReadPool = {} as Pool;
    cm.setReadPool(fakeReadPool);

    const attempts: string[] = [];
    (cm as unknown as { initDirectPool: () => Promise<Pool> }).initDirectPool =
      async function (this: { _directUrl: string }) {
        attempts.push(this._directUrl);
        throw unreachable();
      };

    const pool = await cm.ddl();
    expect(pool).toBe(fakeReadPool);
    expect(attempts.length).toBe(2); // direct, then session — exactly once each
    expect(cm.isKillSwitchActive()).toBe(true);
    expect(cm.isDualPoolActive()).toBe(false);
    expect(errLines.filter(l => l.includes('GBRAIN_DIRECT_DATABASE_URL')).length).toBe(1);
    // Subsequent calls stay on the read pool without new attempts.
    expect(await cm.ddl()).toBe(fakeReadPool);
    expect(attempts.length).toBe(2);
  }, 20000);

  test('explicit directUrl override is respected as-is — NO session second-guessing', async () => {
    const cm = new ConnectionManager({
      url: POOLER_URL,
      directUrl: 'postgresql://postgres:p@10.11.12.13:5432/db', // operator says THIS
    });
    const fakeReadPool = {} as Pool;
    cm.setReadPool(fakeReadPool);

    const attempts: string[] = [];
    (cm as unknown as { initDirectPool: () => Promise<Pool> }).initDirectPool =
      async function (this: { _directUrl: string }) {
        attempts.push(this._directUrl);
        throw unreachable();
      };

    const pool = await cm.ddl();
    expect(pool).toBe(fakeReadPool); // straight to the #1641 fallback
    expect(attempts.length).toBe(1); // no session retry on operator overrides
    expect(cm.isKillSwitchActive()).toBe(true);
  }, 20000);
});
