/**
 * GBRA-789: `gbrain status` on a healthy keyless, repo-less brain. The default
 * source keeps its pages in the database (no Git checkout to sync) and
 * embeddings are off on purpose, so it must not read "[UNKNOWN] … never …
 * embed=0%"; and after `gbrain dream` completes a full cycle, "Last full
 * cycle" names it instead of "never run".
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runStatus } from '../src/commands/status.ts';
import { runDream } from '../src/commands/dream.ts';
import { completedFullCycle } from '../src/core/dream-last-cycle.ts';
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

  test('a source-scoped gbrain dream is not recorded as the full cycle', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('scoped-example', 'scoped-example', '{}')`);
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const write = spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await withEnv({ GBRAIN_HOME: home }, () => runDream(engine, ['--json', '--source', 'scoped-example']));
    } finally {
      log.mockRestore();
      write.mockRestore();
      await engine.executeRaw(`DELETE FROM sources WHERE id = 'scoped-example'`);
    }
    expect(await engine.getConfig('dream.last_full_cycle')).toBeNull();
  }, 120_000);

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

  test('a never-synced connector source is not called repo-less', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('slack-example', 'slack-example', '{"kind":"slack","s_channels":"general"}')`);
    try {
      const line = (await status()).split('\n').find(l => /\] slack-example\b/.test(l))!;
      expect(line).toBeDefined();
      expect(line).not.toContain('repo-less');
      expect(line).toContain('never');
    } finally {
      await engine.executeRaw(`DELETE FROM sources WHERE id = 'slack-example'`);
    }
  });

  test('a default source whose checkout is recorded in sync.repo_path is not called repo-less', async () => {
    await engine.setConfig('sync.repo_path', join(home, 'brain-checkout'));
    try {
      const line = (await status()).split('\n').find(l => /\] default\b/.test(l))!;
      expect(line).toBeDefined();
      expect(line).not.toContain('repo-less');
    } finally {
      await engine.unsetConfig('sync.repo_path');
    }
  });

  test('an aborted or lock-stolen cycle is not a completed full cycle', () => {
    expect(completedFullCycle({ status: 'partial', reason: 'aborted' })).toBe(false);
    expect(completedFullCycle({ status: 'partial', reason: 'lock_stolen' })).toBe(false);
    expect(completedFullCycle({ status: 'partial' })).toBe(true);
    expect(completedFullCycle({ status: 'ok' })).toBe(true);
    expect(completedFullCycle({ status: 'failed' })).toBe(false);
  });

  test('a never-synced source with a local folder is not called repo-less', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-status-plain-'));
    writeFileSync(join(dir, 'a.md'), '# A');
    await engine.executeRaw(`INSERT INTO sources (id, name, local_path, config) VALUES ('plain-example', 'plain-example', $1, '{}')`, [dir]);
    try {
      const line = (await status()).split('\n').find(l => /\] plain-example\b/.test(l))!;
      expect(line).toBeDefined();
      expect(line).not.toContain('repo-less');
      expect(line).toContain('never');
    } finally {
      await engine.executeRaw(`DELETE FROM sources WHERE id = 'plain-example'`);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
