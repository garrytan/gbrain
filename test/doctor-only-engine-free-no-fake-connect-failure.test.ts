/** #9527 — an engine-free `--only` run must not claim the database checks stopped early. */
import { test, expect } from 'bun:test';
import { runDoctor } from '../src/commands/doctor.ts';
import { withEnv } from './helpers/with-env.ts';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

test('--only skill_resolver without an engine reports no finding, no connection failure', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-9527-'));
  const out: string[] = [];
  const origLog = console.log;
  const origExitCode = process.exitCode;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(' ')); };
  try {
    await withEnv({ GBRAIN_HOME: home, GBRAIN_SKILLS_DIR: undefined, OPENCLAW_WORKSPACE: undefined }, async () => {
      await runDoctor(null, ['--only', 'skill_resolver', '--json'], 'config-file');
    });
  } finally {
    console.log = origLog;
    process.exitCode = origExitCode ?? 0;
    rmSync(home, { recursive: true, force: true });
  }
  const line = out.join('\n').split('\n').find((l) => l.trim().startsWith('{"schema_version"'));
  const checks = (JSON.parse(line ?? '{}').checks ?? []) as { name: string; message: string }[];
  expect(checks.find((c) => c.name === 'connection')).toBeUndefined();
  const row = checks.find((c) => c.name === 'skill_resolver');
  expect(row?.message ?? '').toContain('No finding');
});
