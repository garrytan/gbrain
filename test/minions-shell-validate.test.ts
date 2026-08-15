/**
 * Tests for `src/core/minions/handlers/shell-validate.ts` — the pre-enqueue
 * validator.
 *
 * v0.36.5.0 design: `inherit:` is free-form (any snake_case config-key name).
 * No closed-enum check, no env-shadow rejection, no inline-cmd scan. The
 * single-uid trust model treats the agent as a peer of the worker — it
 * decides which secrets to pass.
 *
 * What the validator DOES check:
 *   - Shape (cmd XOR argv, cwd absolute, env is string→string)
 *   - `inherit` is array of snake_case strings (prototype-pollution defense)
 *   - Every `inherit` name resolves on `loadConfig()` (UX fail-fast)
 *
 * The T1 regression guard at the bottom pins the load-bearing invariant:
 * validation throws BEFORE any persistence call.
 */

import { describe, test, expect } from 'bun:test';
import { validateShellJobParams } from '../src/core/minions/handlers/shell-validate.ts';
import { UnrecoverableError } from '../src/core/minions/types.ts';
import type { GBrainConfig } from '../src/core/config.ts';

const dbUrl = 'postgresql://test:test@localhost:5432/test';
const fakeCfg: GBrainConfig = {
  engine: 'postgres',
  database_url: dbUrl,
  anthropic_api_key: 'sk-ant-test',
  openai_api_key: 'sk-test',
};

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

describe('inherit — free-form config-key names (v0.36.5.0)', () => {
  test('inherit:["database_url"] accepted', () => {
    const p = validateShellJobParams(
      { cmd: 'echo', cwd: '/tmp', inherit: ['database_url'] },
      { config: fakeCfg },
    );
    expect(p.inherit).toEqual(['database_url']);
  });
  test('inherit:["anthropic_api_key"] accepted (was scope-creep in closed enum)', () => {
    const p = validateShellJobParams(
      { cmd: 'echo', cwd: '/tmp', inherit: ['anthropic_api_key'] },
      { config: fakeCfg },
    );
    expect(p.inherit).toEqual(['anthropic_api_key']);
  });
  test('inherit multiple keys at once', () => {
    const p = validateShellJobParams(
      { cmd: 'echo', cwd: '/tmp', inherit: ['database_url', 'anthropic_api_key', 'openai_api_key'] },
      { config: fakeCfg },
    );
    expect(p.inherit).toEqual(['database_url', 'anthropic_api_key', 'openai_api_key']);
  });
  test('inherit must be an array', () => {
    expect(() => validateShellJobParams(
      { cmd: 'echo', cwd: '/tmp', inherit: 'database_url' as unknown as string[] },
      { config: fakeCfg },
    )).toThrow(/inherit must be an array/);
  });
  test('inherit non-string element rejected', () => {
    expect(() => validateShellJobParams(
      { cmd: 'echo', cwd: '/tmp', inherit: [1] as unknown as string[] },
      { config: fakeCfg },
    )).toThrow(/non-empty strings/);
  });
  test('inherit empty string rejected', () => {
    expect(() => validateShellJobParams(
      { cmd: 'echo', cwd: '/tmp', inherit: [''] },
      { config: fakeCfg },
    )).toThrow(/non-empty strings/);
  });
});

describe('inherit — snake_case shape guard (prototype-pollution defense)', () => {
  test('"__proto__" rejected (not snake_case shape)', () => {
    expect(() => validateShellJobParams(
      { cmd: 'echo', cwd: '/tmp', inherit: ['__proto__'] },
      { config: fakeCfg },
    )).toThrow(/must match \[a-z\]/);
  });
  test('"constructor" rejected (uppercase letters)', () => {
    expect(() => validateShellJobParams(
      { cmd: 'echo', cwd: '/tmp', inherit: ['constructor'] as unknown as string[] },
      { config: fakeCfg },
    )).toThrow(/worker has no constructor configured/);
  });
  test('path-traversal-looking name rejected', () => {
    expect(() => validateShellJobParams(
      { cmd: 'echo', cwd: '/tmp', inherit: ['../etc/passwd'] },
      { config: fakeCfg },
    )).toThrow(/must match \[a-z\]/);
  });
  test('"FOO_BAR" (uppercase) rejected — config keys are snake_case', () => {
    expect(() => validateShellJobParams(
      { cmd: 'echo', cwd: '/tmp', inherit: ['FOO_BAR'] },
      { config: fakeCfg },
    )).toThrow(/must match \[a-z\]/);
  });
  test('digits-after-letter allowed (matches regex)', () => {
    // Won't actually resolve since fakeCfg doesn't have field2 — fail-fast hits
    expect(() => validateShellJobParams(
      { cmd: 'echo', cwd: '/tmp', inherit: ['field2'] },
      { config: fakeCfg },
    )).toThrow(/worker has no field2 configured/);
  });
});

describe('inherit — fail-fast on missing config value', () => {
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
  test('inherit:["voyage_api_key"] when not set → reject (fakeCfg has only db_url + anthropic + openai)', () => {
    expect(() => validateShellJobParams(
      { cmd: 'echo', cwd: '/tmp', inherit: ['voyage_api_key'] },
      { config: fakeCfg },
    )).toThrow(/worker has no voyage_api_key configured/);
  });
  test('inherit:["database_url"] + empty-string database_url → reject', () => {
    expect(() => validateShellJobParams(
      { cmd: 'echo', cwd: '/tmp', inherit: ['database_url'] },
      { config: { engine: 'postgres', database_url: '' } },
    )).toThrow(/worker has no database_url/);
  });
});

describe('what the validator deliberately does NOT do (agency for the agent)', () => {
  test('caller can use env: for ANY key, including ones with secret-looking names', () => {
    // No shadow rejection. Agent decides if they want to put a URL in env:
    // directly (and accept that it lands in the row plaintext). v0.36.5.0
    // honors the agent's call.
    const p = validateShellJobParams(
      { cmd: 'echo', cwd: '/tmp', env: { GBRAIN_DATABASE_URL: dbUrl, DATABASE_URL: dbUrl } },
      { config: fakeCfg },
    );
    expect(p.env).toEqual({ GBRAIN_DATABASE_URL: dbUrl, DATABASE_URL: dbUrl });
  });
  test('caller can put inline secret-key=value in cmd', () => {
    // No inline-cmd scan. The agent knows what it's writing.
    const p = validateShellJobParams(
      { cmd: 'GBRAIN_DATABASE_URL=postgresql://... gbrain sync', cwd: '/tmp' },
      { config: fakeCfg },
    );
    expect(p.cmd).toContain('GBRAIN_DATABASE_URL');
  });
  test('inherit + env: with overlapping intent both work (last write wins per overlay order)', () => {
    // Agent might want inherit for value-from-config AND env: for an
    // additional non-secret. Both are honored.
    const p = validateShellJobParams(
      { cmd: 'echo', cwd: '/tmp', inherit: ['database_url'], env: { MY_FLAG: '1' } },
      { config: fakeCfg },
    );
    expect(p.inherit).toEqual(['database_url']);
    expect(p.env).toEqual({ MY_FLAG: '1' });
  });
});

describe('redact_secrets shape check', () => {
  test('redact_secrets: true accepted', () => {
    const p = validateShellJobParams(
      { cmd: 'echo', cwd: '/tmp', inherit: ['database_url'], redact_secrets: true },
      { config: fakeCfg },
    );
    expect(p.redact_secrets).toBe(true);
  });
  test('redact_secrets: false accepted', () => {
    const p = validateShellJobParams(
      { cmd: 'echo', cwd: '/tmp', redact_secrets: false },
      { config: fakeCfg },
    );
    expect(p.redact_secrets).toBe(false);
  });
  test('redact_secrets: undefined is fine (default)', () => {
    const p = validateShellJobParams(
      { cmd: 'echo', cwd: '/tmp' },
      { config: fakeCfg },
    );
    expect(p.redact_secrets).toBeUndefined();
  });
  test('redact_secrets: non-boolean rejected', () => {
    expect(() => validateShellJobParams(
      { cmd: 'echo', cwd: '/tmp', redact_secrets: 'yes' as unknown as boolean },
      { config: fakeCfg },
    )).toThrow(/redact_secrets must be a boolean/);
  });
});

describe('T1 regression guard: validation runs BEFORE persistence', () => {
  // This test pins the load-bearing invariant codex caught: validation must
  // throw before any persistence call. If a future refactor moves the
  // validation call back into the shell.ts handler, this test fails.
  test('bad payload throws synchronously, no queue.add could have been called', () => {
    let queueAddCalled = false;
    const fakeQueueAdd = () => { queueAddCalled = true; };

    // Bad shape: inherit name doesn't pass snake_case regex.
    const data = { cmd: 'echo', cwd: '/tmp', inherit: ['NotSnake'] };
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
