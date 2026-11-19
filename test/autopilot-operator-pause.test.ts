/**
 * `foresights autopilot pause|resume` (fix wave 3, Lane D): the operator pause is
 * its own marker. The daemon and workers honor it, status shows it,
 * `autopilot --install` (which `foresights upgrade` runs) keeps it, and resume
 * clears only it — never a migration or restore hold.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { withEnv, emptyHome } from './helpers/with-env.ts';
import { autopilotOperatorPauseMarkerPath, autopilotPaused, autopilotPausedMarkerPath } from '../src/core/autopilot-paths.ts';
import { runAutopilotPauseCommand } from '../src/commands/autopilot-pause.ts';
import { resolveAutopilotPositionals, runAutopilot, runAutopilotStatus } from '../src/commands/autopilot.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import { waitFor } from './helpers/wait-for.ts';

function out(run: () => unknown): string {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); };
  try { run(); } finally { console.log = log; }
  return lines.join('\n');
}

describe('autopilot operator pause', () => {
  test('pause and resume are subcommands', () => {
    expect(resolveAutopilotPositionals(['pause', '--reason', 'upgrade window'])).toEqual(['--pause', '--reason', 'upgrade window']);
    expect(resolveAutopilotPositionals(['resume'])).toEqual(['--resume']);
  });

  test('pause writes its own marker, pauses the daemon and workers, and status shows it', async () => {
    await withEnv({ GBRAIN_HOME: emptyHome() }, () => {
      expect(autopilotPaused()).toBe(false);
      const text = out(() => runAutopilotPauseCommand(['--pause', '--reason', 'upgrade window']));
      expect(text).toContain('Autopilot paused on this host');
      expect(text).toContain('foresights autopilot resume');
      expect(existsSync(autopilotOperatorPauseMarkerPath())).toBe(true);
      expect(existsSync(autopilotPausedMarkerPath())).toBe(false);
      expect(autopilotPaused()).toBe(true);
      expect(readFileSync(autopilotOperatorPauseMarkerPath(), 'utf8')).toContain('upgrade window');
      const status = JSON.parse(out(() => runAutopilotStatus(['--status', '--json'])));
      expect(status.paused_reason).toContain('operator pause');
      expect(status.paused_reason).toContain('upgrade window');
      // Idempotent: pausing again keeps the pause.
      expect(out(() => runAutopilotPauseCommand(['--pause']))).toContain('already paused');
      expect(out(() => runAutopilotPauseCommand(['--resume']))).toContain('Operator pause cleared');
      expect(autopilotPaused()).toBe(false);
      expect(out(() => runAutopilotPauseCommand(['--resume']))).toContain('No operator pause was set');
    });
  });

  test('resume never clears a migration hold', async () => {
    await withEnv({ GBRAIN_HOME: emptyHome() }, () => {
      const hold = autopilotPausedMarkerPath();
      mkdirSync(dirname(hold), { recursive: true });
      writeFileSync(hold, `paused by foresights migrate (pid ${process.pid})\n`);
      out(() => runAutopilotPauseCommand(['--pause']));
      const text = out(() => runAutopilotPauseCommand(['--resume']));
      expect(text).toContain('Another hold is still present and was not touched');
      expect(existsSync(hold)).toBe(true);
      expect(autopilotPaused()).toBe(true);
    });
  });

  test('autopilot --install (what foresights upgrade runs) keeps the operator pause and clears only a leaked hold', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-autopilot-home-'));
    const repo = mkdtempSync(join(tmpdir(), 'gbrain-autopilot-repo-'));
    const bin = mkdtempSync(join(tmpdir(), 'gbrain-autopilot-bin-'));
    writeFileSync(join(bin, 'gbrain'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await withEnv({ GBRAIN_HOME: emptyHome(), HOME: home, PATH: `${bin}:${process.env.PATH}` }, async () => {
      out(() => runAutopilotPauseCommand(['--pause', '--reason', 'upgrading hosts']));
      writeFileSync(autopilotPausedMarkerPath(), 'leaked by a dead migration\n');
      const engine = { kind: 'postgres', getConfig: async () => null } as never;
      const log = console.log;
      console.log = () => {};
      try { await runAutopilot(engine, ['--install', '--yes', '--target', 'ephemeral-container', '--repo', repo, '--no-inject']); } finally { console.log = log; }
      expect(existsSync(autopilotPausedMarkerPath())).toBe(false);
      expect(existsSync(autopilotOperatorPauseMarkerPath())).toBe(true);
      expect(autopilotPaused()).toBe(true);
    });
  });

  test('the daemon loop skips cycles while the operator pause holds and resumes when it clears', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-operator-pause-daemon-'));
    const env = { PATH: process.env.PATH, HOME: home, GBRAIN_HOME: home, GBRAIN_DISABLE_UPDATE_CHECK: '1', GBRAIN_MODEL_DISCOVERY: 'off' };
    const cli = (...args: string[]) => Bun.spawn([process.execPath, join(import.meta.dir, '..', 'src', 'cli.ts'), ...args],
      { cwd: home, env, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
    try {
      expect(await cli('init', '--pglite', '--no-embedding').exited).toBe(0);
      mkdirSync(join(home, 'repo'));
      expect(await cli('autopilot', 'pause', '--reason', 'upgrade window').exited).toBe(0);
      const daemon = cli('autopilot', '--repo', join(home, 'repo'), '--interval', '1', '--inline');
      let stdout = '';
      const reader = (async () => { for await (const chunk of daemon.stdout) stdout += new TextDecoder().decode(chunk); })();
      try {
        await waitFor(() => stdout.includes('[autopilot] paused'), { timeoutMs: 30_000, label: 'daemon reports the pause' });
        expect(stdout).not.toContain('[autopilot] resumed');
        expect(await cli('autopilot', 'resume').exited).toBe(0);
        await waitFor(() => stdout.includes('[autopilot] resumed'), { timeoutMs: 30_000, label: 'daemon resumes' });
      } finally {
        daemon.kill('SIGTERM');
        await daemon.exited; await reader;
      }
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 120_000);
});

describe('job workers honor the operator pause', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); });
  afterAll(async () => { await engine.disconnect(); });
  beforeEach(async () => { await engine.executeRaw('DELETE FROM minion_jobs'); });

  test('a job worker claims nothing while the operator pause holds and runs the job after resume', async () => {
    await withEnv({ GBRAIN_HOME: emptyHome() }, async () => {
      const worker = new MinionWorker(engine, { pollInterval: 25, lockDuration: 30_000 });
      worker.register('operator-pause-probe', async () => 'ran');
      let running: Promise<void> | undefined;
      try {
        out(() => runAutopilotPauseCommand(['--pause', '--reason', 'upgrade window']));
        const queue = new MinionQueue(engine);
        const job = await queue.add('operator-pause-probe', {}, {}, { allowProtectedSubmit: true });
        const lines: string[] = [];
        const log = console.log;
        console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); };
        try {
          running = worker.start();
          await waitFor(() => lines.some(line => line.includes('pause marker present')), { timeoutMs: 15_000, label: 'worker parks on the pause' });
        } finally { console.log = log; }
        expect((await queue.getJob(job.id))).toMatchObject({ status: 'waiting', attempts_started: 0 });
        out(() => runAutopilotPauseCommand(['--resume']));
        await waitFor(async () => (await queue.getJob(job.id))?.status === 'completed', { timeoutMs: 15_000, label: 'job completes after resume' });
      } finally {
        worker.stop(); await running;
      }
    });
  }, 60_000);

  test('a job claimed as the operator pause lands is released back to the queue un-run', async () => {
    await withEnv({ GBRAIN_HOME: emptyHome() }, async () => {
      const worker = new MinionWorker(engine, { pollInterval: 25, lockDuration: 30_000 });
      let runs = 0;
      worker.register('operator-pause-probe', async () => { runs++; return 'ran'; });
      const queue = (worker as unknown as { queue: MinionQueue }).queue;
      const claim = queue.claim.bind(queue);
      queue.claim = (async (...args: Parameters<MinionQueue['claim']>) => {
        const claimed = await claim(...args);
        if (claimed && runs === 0) out(() => runAutopilotPauseCommand(['--pause', '--reason', 'upgrade window']));
        return claimed;
      }) as MinionQueue['claim'];
      let running: Promise<void> | undefined;
      try {
        const job = await new MinionQueue(engine).add('operator-pause-probe', {}, {}, { allowProtectedSubmit: true });
        const lines: string[] = [];
        const log = console.log;
        console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); };
        try {
          running = worker.start();
          await waitFor(() => lines.some(line => line.includes('pause marker appeared after claim')), { timeoutMs: 15_000, label: 'worker releases the claimed job' });
        } finally { console.log = log; }
        expect(runs).toBe(0);
        expect(await queue.getJob(job.id)).toMatchObject({ status: 'delayed', lock_token: null });
      } finally {
        worker.stop(); await running;
      }
    });
  }, 60_000);
});
