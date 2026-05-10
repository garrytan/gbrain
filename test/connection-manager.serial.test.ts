import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import {
  isSupabasePoolerUrl,
  deriveDirectUrl,
  readKillSwitchEnv,
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

  test('falls back to port-only swap when project-ref unparseable', () => {
    const direct = deriveDirectUrl(
      'postgresql://customuser:secret@some.pooler.supabase.com:6543/db'
    );
    expect(direct).toBeTruthy();
    expect(direct).toContain(':5432');
    expect(direct).toContain('some.pooler.supabase.com'); // host preserved
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
  beforeEach(() => {
    originalKillSwitch = process.env.GBRAIN_DISABLE_DIRECT_POOL;
    delete process.env.GBRAIN_DISABLE_DIRECT_POOL;
  });
  afterEach(() => {
    if (originalKillSwitch === undefined) delete process.env.GBRAIN_DISABLE_DIRECT_POOL;
    else process.env.GBRAIN_DISABLE_DIRECT_POOL = originalKillSwitch;
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
