import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkChildReadiness, parseChildReadiness, CHILD_READINESS_FEATURES,
  CHILD_READINESS_MAX_BYTES, CHILD_READINESS_TIMEOUT_MS,
} from '../src/core/minions/child-readiness.ts';
import { isLocalConfigurationError, LocalConfigurationError } from '../src/core/minions/configuration-error.ts';
import { VERSION } from '../src/version.ts';
import { ChildSpawnInfraError, runJobInChild } from '../src/core/minions/child-job-runner.ts';
import { detectTini } from '../src/core/minions/spawn-helpers.ts';

const reply = {
  protocolVersion: 1, version: VERSION, features: [...CHILD_READINESS_FEATURES], status: 'ready',
};

async function fixture(body: string, run: (invocation: { cmd: string; argsPrefix: string[] }) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'child readiness '));
  const path = join(dir, 'selected child.mjs');
  try {
    writeFileSync(path, body);
    await run({ cmd: process.execPath, argsPrefix: [path] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('selected child readiness protocol', () => {
  test('defaults are bounded and compatible version skew is diagnostic', () => {
    expect(CHILD_READINESS_TIMEOUT_MS).toBe(20_000);
    expect(CHILD_READINESS_MAX_BYTES).toBe(64 * 1024);
    expect(parseChildReadiness(JSON.stringify(reply))).toEqual({ version: VERSION, versionSkew: false });
    expect(parseChildReadiness(JSON.stringify({ ...reply, version: '0.0.1' })))
      .toEqual({ version: '0.0.1', versionSkew: true });
  });

  test('completed malformed, missing-feature and wrong-major replies are permanent and redacted', () => {
    for (const raw of ['', 'null', 'postgres://private:GSTACK_EXAMPLE_NONCE@example.invalid/db', '{}',
      JSON.stringify({ ...reply, protocolVersion: 999 }),
      JSON.stringify({ ...reply, features: ['unknown-feature'] }),
      JSON.stringify({ ...reply, status: 'configuration_error', reasonCode: 'unknown', message: 'password' }),
      JSON.stringify({ ...reply, version: 'postgres://private:GSTACK_EXAMPLE_NONCE@example.invalid/db' }),
      JSON.stringify({ ...reply, version: '1.2.3-private-password' }),
    ]) {
      try { parseChildReadiness(raw); throw new Error('unexpected success'); }
      catch (error) {
        expect(error).toBeInstanceOf(LocalConfigurationError);
        expect((error as Error).message).not.toContain('password');
        expect((error as Error).message).not.toContain('GSTACK_EXAMPLE_NONCE');
      }
    }
  });

  test('only allowlisted typed replies assert capability faults; valid unreachable DB is transient', () => {
    try {
      parseChildReadiness(JSON.stringify({ ...reply, status: 'configuration_error', reasonCode: 'postgres_cancellation_unavailable' }));
      throw new Error('unexpected success');
    }
    catch (error) { expect((error as LocalConfigurationError).reasonCode).toBe('postgres_cancellation_unavailable'); }
    expect(() => parseChildReadiness(JSON.stringify({ ...reply, status: 'transient_error', message: 'password' })))
      .toThrow('transiently');
    try { parseChildReadiness(JSON.stringify({ ...reply, status: 'transient_error' })); }
    catch (error) { expect(isLocalConfigurationError(error)).toBe(false); }
  });

  test('invokes the actual selected path with spaces and hidden command', async () => {
    await fixture(`if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['jobs','child-readiness','--json'])) process.exit(3);
      console.log(${JSON.stringify(JSON.stringify(reply))});`, async (invocation) => {
      expect(await checkChildReadiness({ invocation, tiniPath: '' })).toEqual({ version: VERSION, versionSkew: false });
    });
  });

  test('successful readiness followed by real typed bootstrap failure retains provenance and latches before cleanup', async () => {
    const moduleUrl = new URL('../src/core/minions/run-child.ts', import.meta.url).href;
    const errorUrl = new URL('../src/core/minions/configuration-error.ts', import.meta.url).href;
    await fixture(`
      if (process.argv.includes('child-readiness')) { console.log(${JSON.stringify(JSON.stringify(reply))}); process.exit(0); }
      const {writeChildBootstrapError} = await import(${JSON.stringify(moduleUrl)});
      const {LocalConfigurationError} = await import(${JSON.stringify(errorUrl)});
      const code = writeChildBootstrapError(process.env.GBRAIN_JOB_RESULT_PATH, new LocalConfigurationError('postgres_cancellation_unavailable','private-password'));
      process.exit(code);
    `, async (invocation) => {
      await checkChildReadiness({ invocation, tiniPath: '' });
      let latched = false;
      const started = Date.now();
      const result = runJobInChild({
        invocation, tiniPath: '', jobId: 1, jobName: 'fixture', lockToken: 'fixture',
        abortSignal: new AbortController().signal, shutdownSignal: new AbortController().signal,
        killGraceMs: 100,
        onConfigurationError: (error) => {
          expect(error.reasonCode).toBe('postgres_cancellation_unavailable');
          latched = true;
        },
      });
      await expect(result).rejects.toBeInstanceOf(LocalConfigurationError);
      expect(latched).toBe(true);
      expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    });
  });

  test('ordinary bootstrap failure preserves the original exit-one crash classification without an outcome', async () => {
    const moduleUrl = new URL('../src/core/minions/run-child.ts', import.meta.url).href;
    await fixture(`
      const {writeChildBootstrapError} = await import(${JSON.stringify(moduleUrl)});
      const {existsSync} = await import('node:fs');
      const code = writeChildBootstrapError(process.env.GBRAIN_JOB_RESULT_PATH, new Error('temporary connection failure'));
      if (existsSync(process.env.GBRAIN_JOB_RESULT_PATH)) process.exit(99);
      process.exit(code);
    `, async (invocation) => {
      const error = await runJobInChild({
        invocation, tiniPath: '', jobId: 1, jobName: 'fixture', lockToken: 'fixture',
        abortSignal: new AbortController().signal, shutdownSignal: new AbortController().signal,
      }).then(() => null, (error: unknown) => error);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(ChildSpawnInfraError);
      expect(isLocalConfigurationError(error)).toBe(false);
      expect((error as Error).message).toContain('exit code=1');
    });
  });

  test('completed malformed child blocks without leaking either stream', async () => {
    await fixture(`console.error('postgres://private:GSTACK_EXAMPLE_NONCE@example.invalid/db'); console.log('invalid password');`, async (invocation) => {
      try { await checkChildReadiness({ invocation, tiniPath: '' }); throw new Error('unexpected success'); }
      catch (error) {
        expect(error).toBeInstanceOf(LocalConfigurationError);
        expect((error as Error).message).not.toContain('password');
        expect((error as Error).message).not.toContain('GSTACK_EXAMPLE_NONCE');
      }
    });
  });

  test('combined output flood terminates unfinished child transiently without echoing credentials', async () => {
    await fixture(`process.stdout.write('x'.repeat(40000)); process.stderr.write('password'.repeat(5000)); setInterval(()=>{},1000);`, async (invocation) => {
      const start = Date.now();
      try { await checkChildReadiness({ invocation, tiniPath: '', timeoutMs: 2000 }); throw new Error('unexpected success'); }
      catch (error) {
        expect(isLocalConfigurationError(error)).toBe(false);
        expect((error as Error).message).toContain('combined output limit');
        expect((error as Error).message).not.toContain('password');
        expect((error as Error).message).not.toContain('GSTACK_EXAMPLE_NONCE');
      }
      expect(Date.now() - start).toBeLessThan(2000);
    });
  });

  test('timeout, killed and interrupted children remain transient', async () => {
    for (const body of [`setInterval(()=>{},1000)`, `process.kill(process.pid, 'SIGKILL')`, `process.exit(137)`]) {
      await fixture(body, async (invocation) => {
        for (const tiniPath of [...new Set(['', detectTini()])]) {
          const error = await checkChildReadiness({ invocation, tiniPath, timeoutMs: 100 }).then(() => null, (error: unknown) => error);
          expect(error).toBeInstanceOf(Error);
          expect(isLocalConfigurationError(error)).toBe(false);
        }
      });
    }
    await fixture(`setInterval(()=>{},1000)`, async (invocation) => {
      const abort = new AbortController();
      abort.abort();
      await expect(checkChildReadiness({ invocation, tiniPath: '', signal: abort.signal })).rejects.toThrow('interrupted');
    });
  });

  test('timeout stops the selected process and reaps its invocation before settling, including beneath tini', async () => {
    for (const tiniPath of [...new Set(['', detectTini()])]) {
      await fixture(`import {writeFileSync} from 'node:fs';
        writeFileSync(process.argv[1]+'.pid',String(process.pid));
        setInterval(()=>{},1000);`, async (invocation) => {
        await expect(checkChildReadiness({ invocation, tiniPath, timeoutMs: 500 })).rejects.toThrow('timed out');
        const pid = Number(readFileSync(invocation.argsPrefix[0] + '.pid', 'utf8'));
        try {
          process.kill(pid, 0);
          if (process.platform !== 'linux') throw new Error('Selected child is still alive');
          const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
          expect(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]).toBe('Z');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH' && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      });
    }
  });

  test('ENOENT and EACCES are executable faults without exposing arbitrary paths', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'readiness-executable-'));
    try {
      const denied = join(dir, 'private-password');
      writeFileSync(denied, '#!/bin/sh\nexit 0');
      chmodSync(denied, 0o600);
      for (const cmd of [join(dir, 'missing-password'), denied]) {
        for (const tiniPath of [...new Set(['', detectTini()])]) {
          try { await checkChildReadiness({ invocation: { cmd, argsPrefix: [] }, tiniPath }); throw new Error('unexpected success'); }
          catch (error) {
            expect((error as LocalConfigurationError).reasonCode).toBe('child_executable_invalid');
            expect((error as Error).message).not.toContain('password');
        expect((error as Error).message).not.toContain('GSTACK_EXAMPLE_NONCE');
          }
          let stopped = 0;
          const error = await runJobInChild({
            invocation: { cmd, argsPrefix: [] }, tiniPath, jobId: 1, jobName: 'fixture', lockToken: 'fixture',
            abortSignal: new AbortController().signal, shutdownSignal: new AbortController().signal,
            onExecutionStopped: () => { stopped++; },
          }).then(() => null, (error: unknown) => error);
          expect((error as LocalConfigurationError).reasonCode).toBe('child_executable_invalid');
          expect((error as Error).message).not.toContain('password');
        expect((error as Error).message).not.toContain('GSTACK_EXAMPLE_NONCE');
          expect(stopped).toBe(1);
        }
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('PATH executable lookup preserves compatible child selection beneath tini', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'readiness path '));
    const executable = join(dir, 'selected-example');
    try {
      writeFileSync(executable, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(reply)}'\n`);
      chmodSync(executable, 0o700);
      expect(await checkChildReadiness({
        invocation: { cmd: 'selected-example', argsPrefix: [] }, tiniPath: detectTini(), env: { PATH: dir },
      })).toEqual({ version: VERSION, versionSkew: false });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('job executable permissions are rechecked after successful selected-child readiness', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'readiness-permission-change-'));
    const executable = join(dir, 'selected-example');
    try {
      writeFileSync(executable, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(reply)}'\n`);
      chmodSync(executable, 0o700);
      await checkChildReadiness({ invocation: { cmd: executable, argsPrefix: [] }, tiniPath: detectTini() });
      chmodSync(executable, 0o600);
      const error = await runJobInChild({
        invocation: { cmd: executable, argsPrefix: [] }, tiniPath: detectTini(), jobId: 1, jobName: 'fixture', lockToken: 'fixture',
        abortSignal: new AbortController().signal, shutdownSignal: new AbortController().signal,
      }).then(() => null, (error: unknown) => error);
      expect((error as LocalConfigurationError).reasonCode).toBe('child_executable_invalid');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('exit 126 and 127 alone do not assert native executable failure', async () => {
    for (const code of [126, 127]) {
      await fixture(`process.exit(${code});`, async (invocation) => {
        const error = await runJobInChild({
          invocation, tiniPath: detectTini(), jobId: 1, jobName: 'fixture', lockToken: 'fixture',
          abortSignal: new AbortController().signal, shutdownSignal: new AbortController().signal,
        }).then(() => null, (error: unknown) => error);
        expect(error).toBeInstanceOf(Error);
        expect(isLocalConfigurationError(error)).toBe(false);
        expect((error as Error).message).toContain(`exit code=${code}`);
      });
    }
  });

  test('native executable failures racing prevalidation remain typed behind a wrapper', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'child-exec-race-'));
    const executable = join(dir, 'selected-example');
    const wrapper = join(dir, 'wrapper');
    try {
      for (const action of ['/bin/chmod 600', '/bin/rm -f']) {
        writeFileSync(wrapper, `#!/bin/sh\n${action} "$3"\nshift 2\nexec "$@"\n`);
        chmodSync(wrapper, 0o700);
        for (const mode of ['readiness', 'job']) {
          writeFileSync(executable, '#!/bin/sh\nexit 0\n');
          chmodSync(executable, 0o700);
          const invocation = { cmd: executable, argsPrefix: [] };
          const pending = mode === 'readiness'
            ? checkChildReadiness({ invocation, tiniPath: wrapper })
            : runJobInChild({
                invocation, tiniPath: wrapper, jobId: 1, jobName: 'fixture', lockToken: 'fixture',
                abortSignal: new AbortController().signal, shutdownSignal: new AbortController().signal,
                killGraceMs: 20,
              });
          const error = await pending.then(() => null, (error: unknown) => error);
          expect((error as LocalConfigurationError).reasonCode).toBe('child_executable_invalid');
        }
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('native exec failure with no child PID publishes no-execution evidence once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'child-native-exec-failure-'));
    const executable = join(dir, 'selected-example');
    let stopped = 0;
    try {
      writeFileSync(executable, `#!${join(dir, 'missing-interpreter')}\n`);
      chmodSync(executable, 0o700);
      const error = await runJobInChild({
        invocation: { cmd: executable, argsPrefix: [] }, tiniPath: '', jobId: 1, jobName: 'fixture', lockToken: 'fixture',
        abortSignal: new AbortController().signal, shutdownSignal: new AbortController().signal,
        onExecutionStopped: () => { stopped++; },
      }).then(() => null, (error: unknown) => error);
      expect((error as LocalConfigurationError).reasonCode).toBe('child_executable_invalid');
      expect(stopped).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
