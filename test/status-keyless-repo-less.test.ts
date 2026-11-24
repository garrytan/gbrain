/**
 * GBRA-789: `gbrain status` on a healthy keyless, repo-less brain. The default
 * source keeps its pages in the database (no Git checkout to sync) and
 * embeddings are off on purpose, so it must not read "[UNKNOWN] … never …
 * embed=0%"; and after `gbrain dream` completes a full cycle, "Last full
 * cycle" names it instead of "never run".
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runStatus } from '../src/commands/status.ts';
import { runDream } from '../src/commands/dream.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let home: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  home = mkdtempSync(join(tmpdir(), 'gbrain-status-keyless-'));
  await engine.putPage('notes/acme-example', { type: 'note', title: 'Acme Example', compiled_truth: 'Acme Example met alice-example.', frontmatter: {} } as never);
  await engine.setConfig('embedding_disabled', 'true');
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
});

const status = () => withEnv({ GBRAIN_HOME: home }, async () => {
  let out = '';
  const result = await runStatus(engine, [], { stdout: s => { out += s; }, stderr: () => {} });
  expect(result.exitCode).toBe(0);
  return out;
});

describe('gbrain status on a keyless repo-less brain', () => {
  test('the default source reads as repo-less with embeddings off, not unknown and never synced', async () => {
    const out = await status();
    const line = out.split('\n').find(l => /\] default\b/.test(l))!;
    expect(line).toBeDefined();
    expect(line).not.toContain('[UNKNOWN]');
    expect(line).not.toContain('never');
    expect(line).toContain('repo-less');
    expect(line).toContain('embed=off');
  });

  test('a brain with embeddings on keeps its coverage percentage', async () => {
    await engine.unsetConfig('embedding_disabled');
    try {
      expect(await status()).toMatch(/embed=\d+%/);
    } finally {
      await engine.setConfig('embedding_disabled', 'true');
    }
  });

  test('a completed gbrain dream shows as the last full cycle', async () => {
    expect(await status()).toContain('Last full cycle: never run');
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const write = spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await withEnv({ GBRAIN_HOME: home }, () => runDream(engine, ['--json']));
    } finally {
      log.mockRestore();
      write.mockRestore();
    }
    const out = await status();
    expect(out).not.toContain('Last full cycle: never run');
    expect(out).toMatch(/Last full cycle: \d{4}-\d{2}-\d{2}T/);
  }, 120_000);
});
