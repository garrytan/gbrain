/**
 * Regression coverage for `gbrain providers test --model`.
 *
 * The command intentionally overrides the active model for an isolated smoke
 * test, but it must still honor file-plane provider_base_urls. Otherwise China
 * DashScope users get a false "incorrect API key" from the international
 * endpoint even though their configured regional endpoint works.
 */

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function runProvidersTest(gbrainHome: string, baseUrl: string): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  mkdirSync(join(gbrainHome, '.gbrain'), { recursive: true });
  writeFileSync(
    join(gbrainHome, '.gbrain', 'config.json'),
    JSON.stringify({
      engine: 'pglite',
      database_path: join(gbrainHome, '.gbrain', 'brain.pglite'),
      embedding_model: 'openai:text-embedding-3-small',
      embedding_dimensions: 1024,
      provider_base_urls: {
        dashscope: baseUrl,
      },
    }),
  );

  const proc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'providers', 'test', '--touchpoint', 'embedding', '--model', 'dashscope:text-embedding-v4'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env,
      GBRAIN_HOME: gbrainHome,
      DASHSCOPE_API_KEY: 'sk-test',
      OPENAI_API_KEY: undefined,
      DATABASE_URL: undefined,
      GBRAIN_DATABASE_URL: undefined,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { exitCode, stdout, stderr };
}

describe('providers test --model base URL routing', () => {
  test('honors provider_base_urls when probing an isolated embedding model', async () => {
    const gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-providers-cli-'));
    const seenUrls: string[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        seenUrls.push(req.url);
        return Response.json({
          data: [{ embedding: Array.from({ length: 1024 }, () => 0) }],
          model: 'text-embedding-v4',
        });
      },
    });

    try {
      const result = await runProvidersTest(gbrainHome, server.url.href.replace(/\/$/, ''));

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('1024 dims');
      expect(result.stderr).toContain('tested dashscope:text-embedding-v4 in isolation');
      expect(seenUrls).toEqual([`${server.url.href.replace(/\/$/, '')}/embeddings`]);
    } finally {
      server.stop(true);
      rmSync(gbrainHome, { recursive: true, force: true });
    }
  });
});
