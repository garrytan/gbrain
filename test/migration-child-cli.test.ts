/**
 * #5184: migration children run the CLI that is running the migration, not
 * whatever `gbrain` PATH resolves to. A PATH `gbrain` can be another version,
 * or a wrapper that sets its own GBRAIN_HOME / database URL, so backfills
 * (extract links/timeline, repair-jsonb), smoke checks and the autopilot
 * install acted on another brain.
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

import { gbrainChildCommand, runGbrainSubprocess } from '../src/commands/migrations/in-process.ts';
import { withEnv } from './helpers/with-env.ts';

const REPO = resolve(import.meta.dir, '..');

describe('#5184 gbrainChildCommand', () => {
  test('a compiled CLI replaces every gbrain command word, including after ||', () => {
    expect(gbrainChildCommand('gbrain get_stats --json 2>/dev/null || gbrain stats', {}, '/opt/gbrain-1/gbrain', undefined))
      .toBe("'/opt/gbrain-1/gbrain' get_stats --json 2>/dev/null || '/opt/gbrain-1/gbrain' stats");
  });

  test('a source run invokes bun with the running cli.ts', () => {
    expect(gbrainChildCommand('gbrain extract links --source db', {}, '/usr/local/bin/bun', '/repo/src/cli.ts'))
      .toBe("'/usr/local/bin/bun' '/repo/src/cli.ts' extract links --source db");
  });

  test('paths with quotes stay one shell word', () => {
    expect(gbrainChildCommand('gbrain jobs smoke', {}, "/opt/o'brien/gbrain", undefined))
      .toBe("'/opt/o'\\''brien/gbrain' jobs smoke");
  });

  test('Windows uses double quotes (execSync runs cmd.exe there)', () => {
    expect(gbrainChildCommand('gbrain jobs smoke', {}, 'C:\\Program Files\\gbrain\\gbrain.exe', undefined, 'win32'))
      .toBe('"C:\\Program Files\\gbrain\\gbrain.exe" jobs smoke');
  });

  test('only command words change: arguments and other commands are left alone', () => {
    expect(gbrainChildCommand('gbrain jobs submit gbrain-x', {}, '/b/gbrain', undefined)).toBe("'/b/gbrain' jobs submit gbrain-x");
    expect(gbrainChildCommand("sh -c 'echo gbrain'", {}, '/b/gbrain', undefined)).toBe("sh -c 'echo gbrain'");
  });

  test('when the running CLI cannot be identified, PATH resolution is kept', () => {
    expect(gbrainChildCommand('gbrain jobs smoke', {}, '/usr/local/bin/bun', '/repo/test/x.test.ts')).toBe('gbrain jobs smoke');
  });
});

describe('#5184 runGbrainSubprocess runs the resolved CLI, not a PATH decoy', () => {
  test('the child is the resolved CLI even with a different gbrain first on PATH', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-5184-'));
    try {
      writeFileSync(join(dir, 'gbrain'), '#!/bin/sh\necho "DECOY $@"\n', { mode: 0o755 });
      const running = join(dir, 'running-cli');
      writeFileSync(running, '#!/bin/sh\necho "RUNNING $@"\n', { mode: 0o755 });
      await withEnv({ PATH: `${dir}:${process.env.PATH ?? ''}`, GBRAIN_JOB_CHILD_CLI: running }, () => {
        expect(runGbrainSubprocess('gbrain extract links --source db').trim()).toBe('RUNNING extract links --source db');
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('#5184 no migration spawns a name-resolved gbrain', () => {
  test('every direct execSync of a gbrain command goes through gbrainChildCommand', () => {
    const dir = join(REPO, 'src', 'commands', 'migrations');
    const offenders: string[] = [];
    for (const file of readdirSync(dir).filter(f => f.endsWith('.ts'))) {
      // test-reads-source-ok[structural]: every migration spawn site, including ones only reachable mid-upgrade, must use the resolved CLI.
      const src = readFileSync(join(dir, file), 'utf-8');
      const lines = src.split('\n');
      lines.forEach((line, i) => {
        if (/^\s*(\/\/|\*)/.test(line)) return;
        if (/(?:execSync|spawnSync|execFileSync)\(\s*['"`]gbrain\b/.test(line)) offenders.push(`${file}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
