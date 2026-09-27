#!/usr/bin/env bun
// Preserve live CI output while recording the timestamps used by the weight miner.
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { once } from 'node:events';
import { constants } from 'node:os';
import type { Readable, Writable } from 'node:stream';

const MAX_PENDING_CHARS = 64 * 1024;

export async function captureTestLog(job: string, out: string, command: string[]): Promise<number> {
  if (!job || /[\r\n\t]/.test(job) || !out || command.length === 0) {
    throw new Error('job, output path and command are required; job must occupy one TSV field');
  }
  mkdirSync(dirname(out), { recursive: true });
  const log = createWriteStream(out);
  await once(log, 'open');
  const grouped = process.platform !== 'win32';
  const child = spawn(command[0]!, command.slice(1), {
    detached: grouped,
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  let receivedSignal: 'SIGTERM' | 'SIGINT' | undefined;
  const forward = (signal: 'SIGTERM' | 'SIGINT') => {
    receivedSignal ??= signal;
    try {
      // The group belongs solely to this invocation, including shell pipelines.
      if (grouped && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch { /* child exited before the signal arrived */ }
  };
  const onTerm = () => forward('SIGTERM');
  const onInt = () => forward('SIGINT');
  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onInt);
  let spawnError: Error | undefined;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once('error', error => { spawnError = error; });
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  let logError: Error | undefined;
  const onLogError = (error: Error) => { logError = error; forward('SIGTERM'); };
  log.on('error', onLogError);
  const write = async (stream: Writable, data: string | Buffer) => {
    if (stream === log && logError) throw logError;
    if (!stream.write(data)) await once(stream, 'drain');
  };
  const record = (line: string) => write(log, `${job}\tcapture\t${new Date().toISOString()} ${line}\n`);
  const consume = async (source: Readable, mirror: Writable) => {
    const decoder = new TextDecoder();
    let pending = '';
    for await (const chunk of source) {
      await write(mirror, chunk);
      pending += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = pending.indexOf('\n')) >= 0) {
        // Large single-line diagnostics are split only in the artifact. Live
        // stdout/stderr remain byte-for-byte unchanged and buffering is bounded.
        const length = Math.min(newline, MAX_PENDING_CHARS);
        await record(pending.slice(0, length).replace(/\r$/, ''));
        pending = pending.slice(length + (length === newline ? 1 : 0));
      }
      while (pending.length > MAX_PENDING_CHARS) {
        await record(pending.slice(0, MAX_PENDING_CHARS));
        pending = pending.slice(MAX_PENDING_CHARS);
      }
    }
    pending += decoder.decode();
    if (pending) await record(pending);
  };
  const guardedConsume = (source: Readable, mirror: Writable) => consume(source, mirror).catch(error => {
    // Stop the owned process group immediately if recording or mirroring fails;
    // waiting for its other pipe first could leave a long-running child alive.
    forward('SIGTERM');
    throw error;
  });
  try {
    await record('##[gbrain-capture-start]');
    const streams = await Promise.allSettled([
      guardedConsume(child.stdout!, process.stdout), guardedConsume(child.stderr!, process.stderr),
    ]);
    const failed = streams.find(result => result.status === 'rejected');
    const result = await exited;
    if (spawnError) throw spawnError;
    if (failed?.status === 'rejected') throw failed.reason;
    if (logError) throw logError;
    const code = receivedSignal ? (receivedSignal === 'SIGINT' ? 130 : 143)
      : result.signal ? 128 + (constants.signals[result.signal] ?? 1)
      : result.code ?? 1;
    // A Bun summary can pass before its outer runner detects another failure.
    // Keep failed artifacts fail-closed when mined without GitHub run metadata.
    if (code !== 0) await record(`##[error]captured command exited ${code}`);
    await record(`##[gbrain-capture-complete] exit=${code}`);
    await new Promise<void>((resolve, reject) => {
      log.once('error', reject);
      log.end(resolve);
    });
    return code;
  } finally {
    process.off('SIGTERM', onTerm);
    process.off('SIGINT', onInt);
    log.destroy();
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  let job = '', out = '';
  let i = 0;
  for (; i < args.length && args[i] !== '--'; i++) {
    if (args[i] === '--job') job = args[++i] ?? '';
    else if (args[i] === '--out') out = args[++i] ?? '';
    else throw new Error(`unknown option ${args[i]}`);
  }
  return captureTestLog(job, out, args[i] === '--' ? args.slice(i + 1) : []);
}
if (import.meta.main) main().then(code => { process.exitCode = code; }).catch(error => {
  console.error(`capture-test-log: ${error.message}`);
  process.exitCode = 2;
});
