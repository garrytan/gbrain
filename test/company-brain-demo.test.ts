import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runCompanyBrainDemo } from '../src/core/company-brain/demo.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { withEnv } from './helpers/with-env.ts';

const homes: string[] = [];
function home() { const path = mkdtempSync(join(tmpdir(), 'company-demo-')); homes.push(path); return path; }
afterEach(() => {
  __setEmbedTransportForTests(null);
  resetGateway();
  for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('offline company-brain demonstration', () => {
  test('runs actual typed import and graph extraction with providers disabled', async () => {
    const directory = home();
    let embeddingCalls = 0;
    configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-test' } });
    __setEmbedTransportForTests(async () => { embeddingCalls++; throw new Error('The offline demo must not embed.'); });
    await withEnv({ GBRAIN_HOME: directory }, async () => {
      const result = await runCompanyBrainDemo();
      expect(result).toMatchObject({ status: 'complete', fictional: true, pages: 15,
        types: { customer: 1, decision: 2, company: 1, product: 1 } });
      expect(result.links).toBeGreaterThan(0);
      expect(result.answers[0].answer).toBe('Alice Example owns the account; Bob Example is its champion.');
      expect(result.answers[0].citations).toContain('company-demo::customers/acme-example');
      expect(result.answers[1].citations).toEqual([
        'company-demo::decisions/2026-08-20-focus-3pl',
        'company-demo::decisions/2026-05-02-focus-grocery',
        'company-demo::meetings/2026-08-19-gtm-review',
      ]);
    });
    expect(embeddingCalls).toBe(0);
    expect(readdirSync(directory)).toEqual([]);
  }, 120_000);

  test('CLI produces one JSON result without a configured brain', () => {
    const directory = home();
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !key.startsWith('GBRAIN_') && !['DATABASE_URL', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'].includes(key)));
    const result = Bun.spawnSync([process.execPath, resolve(import.meta.dir, '../src/cli.ts'), 'sources', 'demo', 'company-brain', '--json'], {
      env: { ...env, GBRAIN_HOME: directory, GBRAIN_NO_BANNER: '1' }, cwd: directory,
      stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', timeout: 60_000,
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toMatchObject({ schema_version: 1, status: 'complete', fictional: true, pages: 15 });
    expect(existsSync(join(directory, '.gbrain'))).toBe(false);
  }, 90_000);
});
