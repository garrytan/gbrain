/**
 * gbrain transcripts archive status says when free upkeep will not run the archive by itself: with maintenance.auto
 * false the serve's idle upkeep and gbrain maintain --unattended skip it, so the line names the on-demand run. The
 * --json document is unchanged. PGLite, no reader is run.
 */
import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runTranscriptsArchive } from '../src/commands/transcripts-archive.ts';
import { ARCHIVE_TIMEZONE_KEY, setArchiveEnabled } from '../src/core/transcripts/archive.ts';
import { MAINTENANCE_AUTO_KEY } from '../src/core/maintenance/run.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'archive-status-auto-'));
let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);
afterAll(async () => {
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
});
beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig(ARCHIVE_TIMEZONE_KEY, 'UTC');
  await engine.setConfig('brain.audience', 'personal');
  await setArchiveEnabled(engine, true);
});

async function status(auto: string | null, json = false): Promise<string> {
  if (auto !== null) await engine.setConfig(MAINTENANCE_AUTO_KEY, auto);
  const log = spyOn(console, 'log').mockImplementation(() => {});
  try {
    await withEnv({ GBRAIN_HOME: home, HOME: home, GBRAIN_OPENCLAW_GATEWAY_URL: undefined }, () => runTranscriptsArchive(engine, ['status', ...(json ? ['--json'] : [])]));
    return log.mock.calls.map(call => call.join(' ')).join('\n');
  } finally {
    log.mockRestore();
  }
}

const LINE = 'maintenance.auto is false';

test('maintenance.auto false: status says upkeep will not archive and names the on-demand run', async () => {
  const out = await status('false');
  expect(out).toContain(LINE);
  expect(out).toContain('gbrain transcripts archive run');
}, 60_000);

test('maintenance.auto true or unset: no such line', async () => {
  expect(await status(null)).not.toContain(LINE);
  expect(await status('true')).not.toContain(LINE);
}, 60_000);

test('the --json document is the same whatever maintenance.auto says', async () => {
  const unset = JSON.parse(await status(null, true));
  const off = JSON.parse(await status('false', true));
  expect(off).toEqual(unset);
}, 60_000);
