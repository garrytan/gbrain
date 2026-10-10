#!/usr/bin/env bun
// Preserve live CI output while recording the timestamps used by the weight miner.
import { spawn } from 'node:child_process';
import { appendFileSync, createWriteStream, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { once } from 'node:events';
import { constants } from 'node:os';
import type { Readable, Writable } from 'node:stream';

const MAX_PENDING_CHARS = 64 * 1024;
const SUMMARY_FAILURES = 50;
const ERROR_LINES = 15;

export interface CapturedFailure { file: string; test: string; arm: string; error: string[]; timedOut?: boolean }

/**
 * The log shape of oven-sh/bun#34069 (fixed upstream by oven-sh/bun#44581,
 * commit 13a98b0; in no Bun release as of 2026-10-09): a GC finalizer that
 * runs while `Bun.spawnSync` waits leaves the runtime's private spawnSync
 * loop with a drifted poll count for the life of the process, after which
 * every synchronous child spawn with the matching poll count spins until the
 * test deadline kills it (`killed N dangling process`) and returns empty
 * output. Once it starts, the rest of the shard's sync-spawning tests time
 * out one after another, in files that have nothing to do with each other.
 */
export const BUN_SPAWNSYNC_POISONED = 'bun_spawnsync_poisoned';

/**
 * Reads the live test output line by line and keeps the last 50 failures
 * with the context an agent needs: file, test, backend arm, the first error
 * block Bun printed above the `(fail)` line, and a reproduction command.
 * Memory stays bounded: only the lines since the last test result are held.
 */
export class FailureCollector {
  failures: CapturedFailure[] = [];
  total = 0;
  private file = '';
  private arm = '';
  private fileFailures = 0;
  private justFailed = false;
  private block: string[] = [];
  private tail: string[] = [];
  bunVersion = '';
  danglingKills = 0;
  private failuresSinceKill = 0;
  private timeoutsSinceKill = 0;
  private filesSinceKill = new Set<string>();
  feed(raw: string): void {
    const line = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
    this.tail.push(line);
    if (this.tail.length > 20) this.tail.shift();
    // Bun prints a timeout or hook note right below its (fail) line.
    const last = this.failures[this.failures.length - 1];
    if (this.justFailed && last && /^\s+\^ /.test(line)) {
      last.error.push(line.trim());
      if (/timed out after/.test(line)) { last.timedOut = true; if (this.danglingKills) this.timeoutsSinceKill++; }
      return;
    }
    this.justFailed = false;
    const bun = /^bun\stest v(\S+)/.exec(line);
    if (bun) this.bunVersion = bun[1];
    if (/^killed \d+ dangling process(?:es)?$/.test(line)) this.danglingKills++;
    const header = /^(?:::group::|##\[group\])?(\S.*\.test\.[cm]?[jt]sx?):$/.exec(line);
    if (header) { this.file = header[1]; this.fileFailures = 0; this.block = []; return; }
    if (/^=== .+ ===$/.test(line)) { this.arm = ''; this.fileFailures = 0; this.block = []; return; }
    const pooled = /^--- .+ \[(\S+)\] ---$/.exec(line);
    if (pooled) { this.arm = pooled[1]; this.block = []; return; }
    const failed = /^(?:\(fail\)|✗) (.*?)(?: \[[0-9.]+m?s\])?$/.exec(line);
    if (failed) { this.push(failed[1]); return; }
    const runner = /^FAILED: (.+)$/.exec(line);
    // run-e2e.sh's per-file verdict: only news when Bun printed no (fail) for that file.
    if (runner) { if (!this.fileFailures) this.push(`(runner) ${runner[1]}`, [line]); return; }
    if (/^\((pass|skip|todo)\) /.test(line) || /^[✓»] /.test(line)) { this.block = []; return; }
    this.block.push(line);
    if (this.block.length > 200) this.block.splice(0, this.block.length - 200);
  }
  private push(test: string, error = this.block): void {
    const trimmed = [...error];
    while (trimmed.length && !trimmed[0].trim()) trimmed.shift();
    while (trimmed.length && !trimmed[trimmed.length - 1].trim()) trimmed.pop();
    this.failures.push({ file: this.file, test, arm: this.arm, error: trimmed.slice(0, ERROR_LINES) });
    if (this.failures.length > SUMMARY_FAILURES) this.failures.shift();
    this.total++;
    this.fileFailures++;
    if (this.danglingKills) { this.failuresSinceKill++; this.filesSinceKill.add(this.file); }
    this.justFailed = true;
    this.block = [];
  }
  /**
   * Whether the run carries the oven-sh/bun#34069 signature: a dangling child
   * killed at a test deadline, and from then on nothing but timeouts, at least
   * three of them, in at least two files. One hung test with a dangling child,
   * a run of timeouts with no killed child, or any non-timeout failure after
   * the kill is some other hang and is left for its own diagnosis.
   */
  poisoned(): boolean {
    return this.danglingKills > 0 && this.timeoutsSinceKill >= 3
      && this.timeoutsSinceKill === this.failuresSinceKill && this.filesSinceKill.size >= 2;
  }
  /** The one-paragraph verdict for a poisoned run, Markdown; empty otherwise. */
  poisonedNote(): string {
    if (!this.poisoned()) return '';
    const bun = this.bunVersion ? `Bun v${this.bunVersion}` : 'this Bun';
    return `> **${BUN_SPAWNSYNC_POISONED}**: \`killed N dangling process\` was followed by ${this.timeoutsSinceKill} timed-out tests across ${this.filesSinceKill.size} files and no other kind of failure. `
      + `That is the ${bun} runtime defect oven-sh/bun#34069: a GC finalizer that ran while an earlier \`Bun.spawnSync\` waited left the runtime's spawnSync loop with a drifted poll count, and from then on every synchronous child spawn (\`spawnSync\`, \`execSync\`, \`execFileSync\`) in this process spins until the test deadline and returns empty output. `
      + `The failures below say nothing about the tests; rerun the job. Fixed upstream by oven-sh/bun#44581 (commit 13a98b0), in no Bun release as of 2026-10-09; TODOS.md tracks the Bun bump.`;
  }
  /** Markdown for $GITHUB_STEP_SUMMARY after a failed run. */
  render(job: string, out: string, code: number): string {
    const fence = (lines: string[]) => {
      const text = lines.join('\n');
      const ticks = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(m => m[0].length + 1)));
      return `${ticks}text\n${text}\n${ticks}`;
    };
    const esc = (v: string) => v.replace(/([|`*_<[\]\\])/g, '\\$1').replace(/@/g, '@\u200b');
    const parts = [`### ${esc(job)}: exited ${code}`, '', `Full log: the job's uploaded timing log (${esc(out.split('/').pop() ?? out)}).`, ''];
    const poisoned = this.poisonedNote();
    if (poisoned) parts.push(poisoned, '');
    if (!this.failures.length) {
      parts.push('No `(fail)` lines were printed (setup, import or runner failure). Last log lines:', '', fence(this.tail), '');
      return `${parts.join('\n')}\n`;
    }
    const shown = this.total > this.failures.length ? `last ${this.failures.length} of ${this.total}` : `${this.total}`;
    parts.push(`Failing tests (${shown}):`, '');
    for (const f of this.failures) {
      const where = [f.file || '(unknown file)', f.test].map(esc).join(' › ');
      parts.push(`#### ${where}${f.arm ? ` [${esc(f.arm)}]` : ''}`, '');
      if (f.error.length) parts.push(fence(f.error), '');
      const repro = reproCommand(f);
      parts.push(repro.includes('`') ? `Reproduce: \`\` ${repro} \`\`` : `Reproduce: \`${repro}\``, '');
    }
    return `${parts.join('\n')}\n`;
  }
}

export function reproCommand(f: CapturedFailure): string {
  const quote = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
  if (!f.file) return 'see the full log';
  if (f.file.startsWith('test/e2e/') || f.test.startsWith('(runner) ')) return `bash scripts/run-e2e.sh ${f.file}`;
  const pattern = f.test.split(' > ').join(' ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `bun test --timeout=60000 ${f.file} -t ${quote(pattern)}`;
}

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
  const failures = new FailureCollector();
  const record = (line: string) => {
    failures.feed(line);
    return write(log, `${job}\tcapture\t${new Date().toISOString()} ${line}\n`);
  };
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
    if (code !== 0) {
      await record(`##[error]captured command exited ${code}`);
      if (failures.poisoned()) console.error(`capture-test-log: ${BUN_SPAWNSYNC_POISONED}: ${failures.danglingKills} dangling child kill(s) followed only by timeouts; see oven-sh/bun#34069 (fixed by oven-sh/bun#44581). Rerun the job.`);
      const summary = process.env.GITHUB_STEP_SUMMARY;
      // B13: CI's --log-failed can come back empty; the step summary keeps the
      // failing tests, their first error block and a repro command regardless.
      if (summary) {
        try { appendFileSync(summary, failures.render(job, out, code)); }
        catch (error) { console.error(`capture-test-log: could not write the step summary: ${(error as Error).message}`); }
      }
    }
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
