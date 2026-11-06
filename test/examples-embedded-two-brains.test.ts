/**
 * GBRA-283 B3a acceptance: examples/embedded-two-brains.ts, which uses only package exports, runs to completion. It
 * opens two brains with distinct fake providers on 127.0.0.1, puts a page in each, searches, closes, and exits 1 if
 * either provider saw the other brain's key or a brain found the other's page. No provider key from this process
 * reaches it.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const SCRUBBED = /^(OPENAI|ANTHROPIC|VOYAGE|GEMINI|GOOGLE_GENERATIVE_AI|TYPESAFE|JEV_TYPESAFE|GROQ|MISTRAL|DEEPSEEK|TOGETHER|OPENROUTER)_|^(GBRAIN_|DATABASE_URL$|HOME$)/;

describe('examples/embedded-two-brains.ts', () => {
  test('two brains with distinct fake providers never cross keys or pages', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-example-two-brains-'));
    const env = { ...Object.fromEntries(Object.entries(Bun.env).filter(([name]) => !SCRUBBED.test(name))), HOME: home, GBRAIN_HOME: home };
    const run = Bun.spawn(['bun', 'examples/embedded-two-brains.ts'], { cwd: ROOT, env, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);
    expect({ code, failed: stderr.includes('FAILED') ? stderr : null }).toEqual({ code: 0, failed: null });
    expect(stdout).toContain('embedded-two-brains: ok');
  }, 180_000);
});
