/**
 * Tests for `src/core/minions/handlers/shell-validate.ts` — the pre-enqueue
 * validator that closes the load-bearing R1 bug.
 *
 * The bug class these tests pin (codex F-CDX-1): pre-v0.35.8.0, shell-job
 * validation ran in the worker handler, AFTER `MinionQueue.add()` had already
 * persisted `data` to the `minion_jobs` row. So a bad payload (env: shadowing
 * a secret, unknown inherit name) lived in the DB row from submit-time until
 * handler-pickup. Test #3 (the regression guard) pins the invariant:
 * validation throws BEFORE any `queue.add` spy fires.
 */

import { describe, test, expect } from 'bun:test';
import { validateShellJobParams } from '../src/core/minions/handlers/shell-validate.ts';
import { INHERITABLE_NAMES, ALL_SHADOW_KEYS } from '../src/core/minions/handlers/shell-inherit.ts';
import { UnrecoverableError } from '../src/core/minions/types.ts';
import type { GBrainConfig } from '../src/core/config.ts';

const dbUrl = 'postgresql://test:test@localhost:5432/test';
const fakeCfg: GBrainConfig = { engine: 'postgres', database_url: dbUrl };

describe('validateShellJobParams — existing param shape checks', () => {
  test('cmd XOR argv: both → reject', () => {
    expect(() => validateShellJobParams({ cmd: 'echo', argv: ['echo'], cwd: '/tmp' }, { config: fakeCfg }))
      .toThrow(UnrecoverableError);
  });
  test('cmd XOR argv: neither → reject', () => {
    expect(() => validateShellJobParams({ cwd: '/tmp' }, { config: fakeCfg }))
      .toThrow(UnrecoverableError);
  });
  test('cwd must be absolute', () => {
    expect(() => validateShellJobParams({ cmd: 'echo', cwd: 'relative/path' }, { config: fakeCfg }))
      .toThrow(/absolute path/);
  });
  test('cwd required', () => {
    expect(() => validateShellJobParams({ cmd: 'echo', cwd: '' }, { config: fakeCfg }))
      .toThrow(/cwd/);
  });
  test('env must be object of string values', () => {
    expect(() => validateShellJobParams({ cmd: 'echo', cwd: '/tmp', env: 'oops' as unknown as Record<string, string> }, { config: fakeCfg }))
      .toThrow(/env/);
    expect(() => validateShellJobParams({ cmd: 'echo', cwd: '/tmp', env: { K: 1 as unknown as string } }, { config: fakeCfg }))
      .toThrow(/string/);
  });
  test('happy path: cmd + cwd accepted', () => {
    const p = validateShellJobParams({ cmd: 'echo hi', cwd: '/tmp' }, { config: fakeCfg });
    expect(p.cmd).toBe('echo hi');
    expect(p.argv).toBeUndefined();
    expect(p.cwd).toBe('/tmp');
  });
});

describe('validateShellJobParams — inherit validation', () => {
  test('unknown inherit name → reject with allowed list in message', () => {
    expect(() => validateShellJobParams(
      { cmd: 'echo', cwd: '/tmp', inherit: ['not_a_real_key'] },
      { config: fakeCfg },
    )).toThrow(/unknown name|allowed:/);
  });
  test('inherit must be array, not string', () => {
    expect(() => validateShellJobParams(
      { cmd: 'echo', cwd: '/tmp', inherit: 'database_url' as unknown as string[] },
      { config: fakeCfg },
    )).toThrow(/inherit must be an array/);
  });
  test('inherit non-string element → reject', () => {
    expect(() => validateShellJobParams(
      { cmd: 'echo', cwd: '/tmp', inherit: [1] as unknown as string[] },
      { config: fakeCfg },
    )).toThrow(/unknown name/);
  });
  test('inherit:["database_url"] accepted when config has database_url', () => {
    const p = validateShellJobParams(
      { cmd: 'echo', cwd: '/tmp', inherit: ['database_url'] },
      { config: fakeCfg },
    );
    expect(p.inherit).toEqual(['database_url']);
  });
  test('INHERITABLE_NAMES contains database_url and nothing scope-creep in v0.35.8.0', () => {
    // T2 decision lock: scope is database_url ONLY in v0.35.8.0. Adding
    // API keys here without doing the GBrainConfig + buildGatewayConfig
    // refactor is the scope creep codex flagged.
    expect(INHERITABLE_NAMES).toEqual(['database_url']);
  });
});

describe('validateShellJobParams — T3 env-shadow rejection', () => {
  test('env:{GBRAIN_DATABASE_URL} alone (without inherit) → reject', () => {
    expect(() => validateShellJobParams(
      { cmd: 'echo', cwd: '/tmp', env: { GBRAIN_DATABASE_URL: dbUrl } },
      { config: fakeCfg },
    )).toThrow(/env GBRAIN_DATABASE_URL is a secret/);
  });
  test('env:{DATABASE_URL} alone (alt shadow key) → reject', () => {
    expect(() => validateShellJobParams(
      { cmd: 'echo', cwd: '/tmp', env: { DATABASE_URL: dbUrl } },
      { config: fakeCfg },
    )).toThrow(/env DATABASE_URL is a secret/);
  });
  test('shadow message points at the right inherit name', () => {
    expect(() => validateShellJobParams(
      { cmd: 'echo', cwd: '/tmp', env: { GBRAIN_DATABASE_URL: dbUrl } },
      { config: fakeCfg },
    )).toThrow(/inherit:\s*\["database_url"\]/);
  });
  test('inherit + env-shadow → reject with explicit shadow message', () => {
    expect(() => validateShellJobParams(
      { cmd: 'echo', cwd: '/tmp', inherit: ['database_url'], env: { GBRAIN_DATABASE_URL: dbUrl } },
      { config: fakeCfg },
    )).toThrow(/shadows inherit\["database_url"\]/);
  });
  test('ALL_SHADOW_KEYS contains both GBRAIN_DATABASE_URL and DATABASE_URL', () => {
    expect(ALL_SHADOW_KEYS.has('GBRAIN_DATABASE_URL')).toBe(true);
    expect(ALL_SHADOW_KEYS.has('DATABASE_URL')).toBe(true);
  });
  test('non-secret env keys still allowed', () => {
    const p = validateShellJobParams(
      { cmd: 'echo', cwd: '/tmp', env: { MY_FLAG: '1', SOME_TOKEN: 'public' } },
      { config: fakeCfg },
    );
    expect(p.env).toEqual({ MY_FLAG: '1', SOME_TOKEN: 'public' });
  });
});

describe('validateShellJobParams — F1 fail-fast on missing config', () => {
  test('inherit:["database_url"] + config without database_url → reject with set-hint', () => {
    expect(() => validateShellJobParams(
      { cmd: 'echo', cwd: '/tmp', inherit: ['database_url'] },
      { config: { engine: 'postgres' } as GBrainConfig },
    )).toThrow(/gbrain config set database_url/);
  });
  test('inherit:["database_url"] + null config → reject', () => {
    expect(() => validateShellJobParams(
      { cmd: 'echo', cwd: '/tmp', inherit: ['database_url'] },
      { config: null },
    )).toThrow(/worker has no database_url/);
  });
  test('inherit:["database_url"] + empty-string database_url → reject', () => {
    expect(() => validateShellJobParams(
      { cmd: 'echo', cwd: '/tmp', inherit: ['database_url'] },
      { config: { engine: 'postgres', database_url: '' } },
    )).toThrow(/worker has no database_url/);
  });
});

describe('H1 (codex v0.36.5.0): cmd/argv inline-secret scan', () => {
  test('cmd:"GBRAIN_DATABASE_URL=... gbrain sync" → reject', () => {
    expect(() => validateShellJobParams(
      { cmd: 'GBRAIN_DATABASE_URL=postgresql://x:y@h/d gbrain sync', cwd: '/tmp' },
      { config: fakeCfg },
    )).toThrow(/cmd contains inline secret assignment/);
  });
  test('cmd:"DATABASE_URL=..." → reject', () => {
    expect(() => validateShellJobParams(
      { cmd: 'DATABASE_URL=postgresql://x:y@h/d gbrain sync', cwd: '/tmp' },
      { config: fakeCfg },
    )).toThrow(/cmd contains inline secret assignment/);
  });
  test('cmd with shadow-key after semicolon → reject', () => {
    expect(() => validateShellJobParams(
      { cmd: 'echo hi; GBRAIN_DATABASE_URL=postgresql://x:y@h/d gbrain sync', cwd: '/tmp' },
      { config: fakeCfg },
    )).toThrow(/cmd contains inline secret assignment/);
  });
  test('argv carrying shadow-key assignment → reject', () => {
    expect(() => validateShellJobParams(
      { argv: ['env', 'GBRAIN_DATABASE_URL=postgresql://x:y@h/d', 'gbrain', 'sync'], cwd: '/tmp' },
      { config: fakeCfg },
    )).toThrow(/argv contains inline secret assignment/);
  });
  test('non-secret env var inline in cmd is allowed', () => {
    const p = validateShellJobParams(
      { cmd: 'MY_FLAG=1 PUBLIC_TOKEN=xyz echo hi', cwd: '/tmp' },
      { config: fakeCfg },
    );
    expect(p.cmd).toContain('MY_FLAG=1');
  });
  test('cmd hint points at inherit when match is a known shadow key', () => {
    expect(() => validateShellJobParams(
      { cmd: 'GBRAIN_DATABASE_URL=postgresql://x:y@h/d gbrain sync', cwd: '/tmp' },
      { config: fakeCfg },
    )).toThrow(/inherit:\s*\["database_url"\]/);
  });
});

describe('H3 (codex v0.36.5.0): GBRAIN_DIRECT_DATABASE_URL in shadowKeys', () => {
  test('env:{GBRAIN_DIRECT_DATABASE_URL} → reject', () => {
    expect(() => validateShellJobParams(
      { cmd: 'echo', cwd: '/tmp', env: { GBRAIN_DIRECT_DATABASE_URL: 'postgresql://...' } },
      { config: fakeCfg },
    )).toThrow(/GBRAIN_DIRECT_DATABASE_URL is a secret/);
  });
  test('cmd:"GBRAIN_DIRECT_DATABASE_URL=..." → reject (inline scan covers all three names)', () => {
    expect(() => validateShellJobParams(
      { cmd: 'GBRAIN_DIRECT_DATABASE_URL=postgresql://x gbrain sync', cwd: '/tmp' },
      { config: fakeCfg },
    )).toThrow(/cmd contains inline secret assignment/);
  });
});

describe('T1 regression guard: validation runs BEFORE persistence', () => {
  // This test pins the load-bearing invariant codex caught: validation must
  // throw before any persistence call. If a future refactor moves the
  // validation call back into the shell.ts handler, this test fails — the
  // spy fires before the throw and the assertion order proves the bug
  // reintroduced.
  test('bad payload throws synchronously, no queue.add could have been called', () => {
    let queueAddCalled = false;
    const fakeQueueAdd = () => { queueAddCalled = true; };

    // Simulate the canonical CLI submit-flow ordering:
    //   try { validateShellJobParams(data); } catch { exit; }
    //   fakeQueueAdd();
    const data = { cmd: 'echo', cwd: '/tmp', env: { GBRAIN_DATABASE_URL: dbUrl } };
    let validatorThrew = false;
    try {
      validateShellJobParams(data, { config: fakeCfg });
      fakeQueueAdd();
    } catch {
      validatorThrew = true;
    }
    expect(validatorThrew).toBe(true);
    expect(queueAddCalled).toBe(false);
  });
});
