/**
 * `gbrain autopilot pause|resume` (fix wave 3, Lane D): the operator pause is
 * its own marker. The daemon and workers honor it, status shows it,
 * `autopilot --install` (which `gbrain upgrade` runs) keeps it, and resume
 * clears only it — never a migration or restore hold.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { withEnv, emptyHome } from './helpers/with-env.ts';
import { autopilotOperatorPauseMarkerPath, autopilotPaused, autopilotPausedMarkerPath } from '../src/core/autopilot-paths.ts';
import { runAutopilotPauseCommand } from '../src/commands/autopilot-pause.ts';
import { resolveAutopilotPositionals, runAutopilot, runAutopilotStatus } from '../src/commands/autopilot.ts';
import { surfaceSource } from './helpers/source-surface.ts';

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
      expect(text).toContain('gbrain autopilot resume');
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
      writeFileSync(hold, `paused by gbrain migrate (pid ${process.pid})\n`);
      out(() => runAutopilotPauseCommand(['--pause']));
      const text = out(() => runAutopilotPauseCommand(['--resume']));
      expect(text).toContain('Another hold is still present and was not touched');
      expect(existsSync(hold)).toBe(true);
      expect(autopilotPaused()).toBe(true);
    });
  });

  test('autopilot --install (what gbrain upgrade runs) keeps the operator pause and clears only a leaked hold', async () => {
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
      try { await runAutopilot(engine, ['--install', '--target', 'ephemeral-container', '--repo', repo, '--no-inject']); } finally { console.log = log; }
      expect(existsSync(autopilotPausedMarkerPath())).toBe(false);
      expect(existsSync(autopilotOperatorPauseMarkerPath())).toBe(true);
      expect(autopilotPaused()).toBe(true);
    });
  });

  test('the daemon loop and job workers consult both markers', () => {
    const root = join(import.meta.dir, '..', 'src');
    // test-reads-source-ok[structural]: no in-process autopilot tick or worker claim harness exists (TODOS: extract a testable tick); pin both markers at the gates.
    const daemon = surfaceSource('autopilot');
    const worker = readFileSync(join(root, 'core', 'minions', 'worker.ts'), 'utf8');
    expect(daemon).toContain('if (autopilotPaused()) {\n      // Self-heal an orphan');
    expect(worker.match(/existsSync\(autopilotPausedMarkerPath\(\)\) \|\| existsSync\(autopilotOperatorPauseMarkerPath\(\)\)/g)?.length).toBe(2);
  });
});
