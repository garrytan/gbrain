import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChildWorkerShutdownError, runJobInChild } from '../src/core/minions/child-job-runner.ts';
import { detectTini } from '../src/core/minions/spawn-helpers.ts';
import { killProcessGroup } from '../src/core/minions/job-isolation.ts';
import { LocalConfigurationError } from '../src/core/minions/configuration-error.ts';
import { UnrecoverableError } from '../src/core/minions/types.ts';

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('Process fixture did not reach the expected state');
    await Bun.sleep(10);
  }
}

function running(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z';
  } catch { return false; }
}

const tini = detectTini();

for (const tiniPath of ['', tini].filter((value, index, all) => all.indexOf(value) === index)) {
  for (const escaped of [false, true]) {
    test.skipIf(process.platform !== 'linux')(`shutdown preserves group backstop after direct exit (${tiniPath ? 'tini -s' : 'no tini'}, escaped=${escaped})`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'job-descendants-'));
      const pidFile = join(dir, 'grandchild.pid');
      const ready = join(dir, 'ready');
      const parent = join(dir, 'parent.mjs');
      const grandchild = join(dir, 'grandchild.mjs');
      let pid = 0;
      let stopped = false;
      try {
        writeFileSync(grandchild, `import {writeFileSync} from 'node:fs';
          process.on('SIGTERM',()=>{}); writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(()=>{},1000);`);
        writeFileSync(parent, `import {spawn} from 'node:child_process'; import {existsSync,writeFileSync} from 'node:fs';
          process.on('SIGTERM',()=>process.exit(0));
          const child=spawn(process.execPath,[${JSON.stringify(grandchild)}],{detached:${escaped},stdio:'ignore'}); child.unref();
          while(!existsSync(${JSON.stringify(pidFile)})) await new Promise(r=>setTimeout(r,5));
          writeFileSync(${JSON.stringify(ready)},'1'); setInterval(()=>{},1000);`);
        const shutdown = new AbortController();
        const result = runJobInChild({
          jobId: 1, jobName: 'fixture', lockToken: 'fixture',
          invocation: { cmd: process.execPath, argsPrefix: [parent] }, tiniPath,
          abortSignal: new AbortController().signal, shutdownSignal: shutdown.signal, killGraceMs: 100,
          onExecutionStopped: () => { stopped = true; },
        }).catch((error: unknown) => error);
        await until(() => existsSync(ready));
        pid = Number(readFileSync(pidFile, 'utf8'));
        expect(running(pid)).toBe(true);
        shutdown.abort();
        const error = await result;
        expect(error).toBeInstanceOf(ChildWorkerShutdownError);
        expect((error as ChildWorkerShutdownError).executionStopped).toBe(!escaped);
        expect(stopped).toBe(!escaped);
        if (escaped) expect(running(pid)).toBe(true);
        else await until(() => !running(pid));
      } finally {
        if (!pid && existsSync(pidFile)) pid = Number(readFileSync(pidFile, 'utf8'));
        if (pid) {
          if (escaped) killProcessGroup(pid, 'SIGKILL');
          try { process.kill(pid, 'SIGKILL'); } catch {}
          await until(() => !running(pid));
        }
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
}

test.skipIf(process.platform !== 'linux')('failed group signalling returns bounded unconfirmed cleanup while execution remains live', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'job-signal-failure-'));
  const pidFile = join(dir, 'pid');
  const script = join(dir, 'child.mjs');
  let pid = 0;
  let stopped = false;
  try {
    writeFileSync(script, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(pidFile)},String(process.pid)); setInterval(()=>{},1000);`);
    const shutdown = new AbortController();
    const result = runJobInChild({
      jobId: 2, jobName: 'fixture', lockToken: 'fixture',
      invocation: { cmd: process.execPath, argsPrefix: [script] }, tiniPath: '',
      abortSignal: new AbortController().signal, shutdownSignal: shutdown.signal, killGraceMs: 100,
      signalProcessGroup: () => false,
      onExecutionStopped: () => { stopped = true; },
    }).catch((error: unknown) => error);
    await until(() => existsSync(pidFile));
    pid = Number(readFileSync(pidFile, 'utf8'));
    shutdown.abort();
    const error = await result;
    expect(error).toBeInstanceOf(ChildWorkerShutdownError);
    expect((error as ChildWorkerShutdownError).executionStopped).toBe(false);
    expect(stopped).toBe(false);
    expect(running(pid)).toBe(true);
  } finally {
    if (pid) { killProcessGroup(pid, 'SIGKILL'); await until(() => !running(pid)); }
    rmSync(dir, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== 'linux')('oversized output cannot erase unconfirmed configuration shutdown while the child remains live', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'job-oversize-shutdown-'));
  const pidFile = join(dir, 'pid');
  const script = join(dir, 'child.mjs');
  let pid = 0;
  let stopped = false;
  try {
    writeFileSync(script, `import {writeFileSync,truncateSync} from 'node:fs';
      writeFileSync(process.env.GBRAIN_JOB_RESULT_PATH,'');
      truncateSync(process.env.GBRAIN_JOB_RESULT_PATH,33*1024*1024);
      writeFileSync(${JSON.stringify(pidFile)},String(process.pid)); setInterval(()=>{},1000);`);
    const shutdown = new AbortController();
    const result = runJobInChild({
      jobId: 3, jobName: 'fixture', lockToken: 'fixture',
      invocation: { cmd: process.execPath, argsPrefix: [script] }, tiniPath: '',
      abortSignal: new AbortController().signal, shutdownSignal: shutdown.signal, killGraceMs: 20,
      signalProcessGroup: () => false, onExecutionStopped: () => { stopped = true; },
    }).catch((error: unknown) => error);
    await until(() => existsSync(pidFile));
    pid = Number(readFileSync(pidFile, 'utf8'));
    shutdown.abort(new LocalConfigurationError('postgres_cancellation_unavailable', 'fixture'));
    const error = await result;
    expect(error).toBeInstanceOf(ChildWorkerShutdownError);
    expect((error as ChildWorkerShutdownError).executionStopped).toBe(false);
    expect(stopped).toBe(false);
    expect(running(pid)).toBe(true);
  } finally {
    if (pid) { killProcessGroup(pid, 'SIGKILL'); await until(() => !running(pid)); }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('normally exited oversized output retains its unrecoverable classification', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'job-oversize-completed-'));
  const script = join(dir, 'child.mjs');
  try {
    writeFileSync(script, `import {writeFileSync,truncateSync} from 'node:fs';
      writeFileSync(process.env.GBRAIN_JOB_RESULT_PATH,''); truncateSync(process.env.GBRAIN_JOB_RESULT_PATH,33*1024*1024);`);
    await expect(runJobInChild({
      jobId: 4, jobName: 'fixture', lockToken: 'fixture',
      invocation: { cmd: process.execPath, argsPrefix: [script] }, tiniPath: '',
      abortSignal: new AbortController().signal, shutdownSignal: new AbortController().signal,
    })).rejects.toBeInstanceOf(UnrecoverableError);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const typedOutcome of [false, true]) {
  test.skipIf(process.platform !== 'linux' || process.getuid?.() === 0)(`final filesystem cleanup failure preserves shutdown provenance (typed outcome=${typedOutcome})`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'job-final-cleanup-'));
    const ready = join(dir, 'ready');
    const script = join(dir, 'child.mjs');
    let pid = 0;
    let resultDir = '';
    let stopped = false;
    try {
      const outcome = typedOutcome
        ? { outcome: 'error', errorKind: 'local_configuration', protocolVersion: 1, reasonCode: 'postgres_cancellation_unavailable', message: 'fixture' }
        : { outcome: 'error', errorKind: 'generic', message: 'fixture' };
      writeFileSync(script, `import {writeFileSync,chmodSync} from 'node:fs'; import {dirname} from 'node:path';
        const dir=dirname(process.env.GBRAIN_JOB_RESULT_PATH);
        writeFileSync(process.env.GBRAIN_JOB_RESULT_PATH,${JSON.stringify(JSON.stringify(outcome))});
        chmodSync(dir,0o500); writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid,dir})); setInterval(()=>{},1000);`);
      const shutdown = new AbortController();
      const result = runJobInChild({
        jobId: 5, jobName: 'fixture', lockToken: 'fixture',
        invocation: { cmd: process.execPath, argsPrefix: [script] }, tiniPath: '',
        abortSignal: new AbortController().signal, shutdownSignal: shutdown.signal, killGraceMs: 20,
        signalProcessGroup: () => false, onExecutionStopped: () => { stopped = true; },
      }).catch((error: unknown) => error);
      await until(() => existsSync(ready));
      const record = JSON.parse(readFileSync(ready, 'utf8'));
      pid = record.pid;
      resultDir = record.dir;
      shutdown.abort(new LocalConfigurationError('postgres_cancellation_unavailable', 'fixture'));
      const error = await result;
      expect(error).toBeInstanceOf(typedOutcome ? LocalConfigurationError : ChildWorkerShutdownError);
      if (!typedOutcome) expect((error as ChildWorkerShutdownError).executionStopped).toBe(false);
      expect(stopped).toBe(false);
      expect(running(pid)).toBe(true);
      expect(existsSync(resultDir)).toBe(true);
    } finally {
      if (pid) { killProcessGroup(pid, 'SIGKILL'); await until(() => !running(pid)); }
      if (resultDir) { chmodSync(resultDir, 0o700); rmSync(resultDir, { recursive: true, force: true }); }
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test.skipIf(process.platform !== 'linux')('an unobserved wrapper child group never produces positive stop evidence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'job-unknown-wrapper-group-'));
  const wrapper = join(dir, 'wrapper.mjs');
  let stopped = false;
  try {
    writeFileSync(wrapper, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';
      writeFileSync(process.env.GBRAIN_JOB_RESULT_PATH,JSON.stringify({outcome:'error',errorKind:'local_configuration',protocolVersion:1,reasonCode:'postgres_cancellation_unavailable',message:'fixture'}));`);
    chmodSync(wrapper, 0o700);
    const error = await runJobInChild({
      jobId: 6, jobName: 'fixture', lockToken: 'fixture',
      invocation: { cmd: process.execPath, argsPrefix: [] }, tiniPath: wrapper,
      abortSignal: new AbortController().signal, shutdownSignal: new AbortController().signal, killGraceMs: 20,
      onExecutionStopped: () => { stopped = true; },
    }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(LocalConfigurationError);
    expect(stopped).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const liveGrandchild of [false, true]) {
  test.skipIf(process.platform !== 'linux')(`normal successful child exit publishes only supported cleanup evidence (live grandchild=${liveGrandchild})`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'job-normal-stop-proof-'));
    const pidFile = join(dir, 'grandchild.pid');
    const script = join(dir, 'child.mjs');
    let pid = 0;
    let stopped = 0;
    try {
      writeFileSync(script, `import {writeFileSync} from 'node:fs'; import {spawn} from 'node:child_process';
        if (${liveGrandchild}) {
          const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
          child.unref(); writeFileSync(${JSON.stringify(pidFile)},String(child.pid));
        }
        writeFileSync(process.env.GBRAIN_JOB_RESULT_PATH,JSON.stringify({outcome:'success',result:{ok:true}})); process.exit(0);`);
      const result = await runJobInChild({
        jobId: 7, jobName: 'fixture', lockToken: 'fixture',
        invocation: { cmd: process.execPath, argsPrefix: [script] }, tiniPath: '',
        abortSignal: new AbortController().signal, shutdownSignal: new AbortController().signal,
        onExecutionStopped: () => { stopped++; },
      });
      expect(result).toEqual({ ok: true });
      expect(stopped).toBe(liveGrandchild ? 0 : 1);
      if (liveGrandchild) {
        pid = Number(readFileSync(pidFile, 'utf8'));
        expect(running(pid)).toBe(true);
      }
    } finally {
      if (!pid && existsSync(pidFile)) pid = Number(readFileSync(pidFile, 'utf8'));
      if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} await until(() => !running(pid)); }
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

for (const tiniPath of ['', tini].filter((value, index, all) => all.indexOf(value) === index)) {
  for (const kind of ['timeout', 'shutdown', 'configuration'] as const) {
    test.skipIf(process.platform !== 'linux')(`prompt SIGTERM exit settles without the full kill grace and publishes stop evidence (${tiniPath ? 'tini -s' : 'no tini'}, ${kind})`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'job-prompt-settle-'));
      const ready = join(dir, 'ready');
      const script = join(dir, 'child.mjs');
      let stopped = 0;
      try {
        writeFileSync(script, `import {writeFileSync} from 'node:fs';
          process.on('SIGTERM',()=>process.exit(0)); writeFileSync(${JSON.stringify(ready)},'1'); setInterval(()=>{},1000);`);
        const abort = new AbortController();
        const shutdown = new AbortController();
        const result = runJobInChild({
          jobId: 8, jobName: 'fixture', lockToken: 'fixture',
          invocation: { cmd: process.execPath, argsPrefix: [script] }, tiniPath,
          abortSignal: abort.signal, shutdownSignal: shutdown.signal, killGraceMs: 5000,
          onExecutionStopped: () => { stopped++; },
        }).catch((error: unknown) => error);
        await until(() => existsSync(ready));
        const started = performance.now();
        if (kind === 'timeout') abort.abort(new Error('timeout'));
        else if (kind === 'shutdown') shutdown.abort(new Error('worker-shutdown'));
        else shutdown.abort(new LocalConfigurationError('postgres_cancellation_unavailable', 'fixture'));
        const error = await result;
        const settleMs = performance.now() - started;
        console.log(`[prompt-settle] tini=${tiniPath ? 'yes' : 'no'} kind=${kind} settleMs=${Math.round(settleMs)}`);
        expect(settleMs).toBeLessThan(1000);
        expect(stopped).toBe(1);
        if (kind === 'timeout') {
          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).toMatch(/terminated after abort/);
        } else {
          expect(error).toBeInstanceOf(ChildWorkerShutdownError);
          expect((error as ChildWorkerShutdownError).executionStopped).toBe(true);
        }
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }, 15_000);
  }
}

test.skipIf(process.platform !== 'linux')('SIGTERM-ignoring grandchild keeps the group SIGKILL at the grace deadline after a prompt direct exit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'job-deadline-kill-'));
  const pidFile = join(dir, 'grandchild.pid');
  const ready = join(dir, 'ready');
  const parent = join(dir, 'parent.mjs');
  const grandchild = join(dir, 'grandchild.mjs');
  const graceMs = 1500;
  let pid = 0;
  let stopped = 0;
  const signals: Array<{ signal: string; at: number }> = [];
  try {
    writeFileSync(grandchild, `import {writeFileSync} from 'node:fs';
      process.on('SIGTERM',()=>{}); writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(()=>{},1000);`);
    writeFileSync(parent, `import {spawn} from 'node:child_process'; import {existsSync,writeFileSync} from 'node:fs';
      process.on('SIGTERM',()=>process.exit(0));
      const child=spawn(process.execPath,[${JSON.stringify(grandchild)}],{stdio:'ignore'}); child.unref();
      while(!existsSync(${JSON.stringify(pidFile)})) await new Promise(r=>setTimeout(r,5));
      writeFileSync(${JSON.stringify(ready)},'1'); setInterval(()=>{},1000);`);
    const shutdown = new AbortController();
    const result = runJobInChild({
      jobId: 9, jobName: 'fixture', lockToken: 'fixture',
      invocation: { cmd: process.execPath, argsPrefix: [parent] }, tiniPath: '',
      abortSignal: new AbortController().signal, shutdownSignal: shutdown.signal, killGraceMs: graceMs,
      signalProcessGroup: (group, signal) => { signals.push({ signal, at: performance.now() }); return killProcessGroup(group, signal); },
      onExecutionStopped: () => { stopped++; },
    }).catch((error: unknown) => error);
    await until(() => existsSync(ready));
    pid = Number(readFileSync(pidFile, 'utf8'));
    const started = performance.now();
    shutdown.abort();
    await Bun.sleep(graceMs - 500);
    expect(running(pid)).toBe(true);
    expect(signals.map(entry => entry.signal)).toEqual(['SIGTERM']);
    const error = await result;
    const kill = signals.find(entry => entry.signal === 'SIGKILL');
    expect(kill).toBeDefined();
    expect(kill!.at - started).toBeGreaterThanOrEqual(graceMs - 50);
    expect(error).toBeInstanceOf(ChildWorkerShutdownError);
    expect((error as ChildWorkerShutdownError).executionStopped).toBe(true);
    expect(stopped).toBe(1);
    await until(() => !running(pid));
  } finally {
    if (!pid && existsSync(pidFile)) pid = Number(readFileSync(pidFile, 'utf8'));
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} await until(() => !running(pid)); }
    rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);

test.skipIf(process.platform !== 'linux')('unsupported cleanup proof sends the group SIGKILL once the direct child exits and settles unconfirmed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'job-unsupported-settle-'));
  const pidFile = join(dir, 'grandchild.pid');
  const ready = join(dir, 'ready');
  const wrapper = join(dir, 'exec-wrapper.sh');
  const parent = join(dir, 'parent.mjs');
  const grandchild = join(dir, 'grandchild.mjs');
  let pid = 0;
  let stopped = 0;
  const signals: string[] = [];
  const errors: string[] = [];
  const originalError = console.error;
  try {
    writeFileSync(wrapper, '#!/bin/sh\nshift 2\nexec "$@"\n');
    chmodSync(wrapper, 0o700);
    writeFileSync(grandchild, `import {writeFileSync} from 'node:fs';
      process.on('SIGTERM',()=>{}); writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(()=>{},1000);`);
    writeFileSync(parent, `import {spawn} from 'node:child_process'; import {existsSync,writeFileSync} from 'node:fs';
      process.on('SIGTERM',()=>process.exit(0));
      const child=spawn(process.execPath,[${JSON.stringify(grandchild)}],{stdio:'ignore'}); child.unref();
      while(!existsSync(${JSON.stringify(pidFile)})) await new Promise(r=>setTimeout(r,5));
      writeFileSync(${JSON.stringify(ready)},'1'); setInterval(()=>{},1000);`);
    const shutdown = new AbortController();
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    const result = runJobInChild({
      jobId: 10, jobName: 'fixture', lockToken: 'fixture',
      invocation: { cmd: process.execPath, argsPrefix: [parent] }, tiniPath: wrapper,
      abortSignal: new AbortController().signal, shutdownSignal: shutdown.signal, killGraceMs: 5000,
      signalProcessGroup: (group, signal) => { signals.push(signal); return killProcessGroup(group, signal); },
      onExecutionStopped: () => { stopped++; },
    }).catch((error: unknown) => error);
    await until(() => existsSync(ready));
    pid = Number(readFileSync(pidFile, 'utf8'));
    const started = performance.now();
    shutdown.abort(new LocalConfigurationError('postgres_cancellation_unavailable', 'fixture'));
    const error = await result;
    const settleMs = performance.now() - started;
    console.log(`[unsupported-settle] settleMs=${Math.round(settleMs)}`);
    expect(settleMs).toBeLessThan(1000);
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(error).toBeInstanceOf(ChildWorkerShutdownError);
    expect((error as ChildWorkerShutdownError).executionStopped).toBe(false);
    expect(stopped).toBe(0);
    expect(errors.some(line => line.includes('execution stop is unconfirmed'))).toBe(true);
    await until(() => !running(pid));
  } finally {
    console.error = originalError;
    if (!pid && existsSync(pidFile)) pid = Number(readFileSync(pidFile, 'utf8'));
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} await until(() => !running(pid)); }
    rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);
