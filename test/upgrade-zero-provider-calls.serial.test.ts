/**
 * `gbrain post-upgrade` makes zero embedding-provider calls without
 * affirmative consent (security wave ENG-3), in non-TTY and TTY runs.
 *
 * Protects: an upgrade on a brain with an embedding provider configured, with
 * markdown pages below the chunker version and a page holding a private key,
 * completes this release's migrations (the credential-safe re-chunk) without
 * sending anything to the provider. Regression it catches: the chunker-bump
 * re-embed that proceeded on its own (immediately without a TTY, after a 10s
 * Ctrl-C window with one), or a migration that embeds. Existing coverage
 * pinned the old auto-proceed. Serial: spawns the real CLI against a disk
 * PGLite brain and a local fake provider.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { migrations } from '../src/commands/migrations/index.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { keylessBrainEnv } from './helpers/provider-env.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';

const REPO = resolve(import.meta.dir, '..');
const KEY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;
const words = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag}${i} word`).join(' ');
const hasScript = process.platform === 'linux' && existsSync('/usr/bin/script');

let provider: ReturnType<typeof Bun.serve>;
const embeddingCalls: string[] = [];

/** A brain upgraded from the previous release: schema one behind, every older orchestrator recorded complete. */
async function seedBrain(home: string): Promise<void> {
  const dir = join(home, '.gbrain');
  mkdirSync(join(dir, 'migrations'), { recursive: true });
  const databasePath = join(home, 'brain.pglite');
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ engine: 'pglite', database_path: databasePath, ...LEGACY_EMBEDDING_CONFIG }));
  writeFileSync(join(dir, 'migrations', 'completed.jsonl'), migrations.filter(m => m.version !== '0.60.31')
    .map(m => JSON.stringify({ version: m.version, status: 'complete' })).join('\n') + '\n');
  const engine = new PGLiteEngine();
  await engine.connect({ database_path: databasePath });
  try {
    await engine.initSchema();
    await engine.setConfig('mcp.publish_skills_prompted', 'true');
    for (const [slug, body] of [['notes/old-chunker', `## Old\n\n${words(40, 'legacy')}\n`], ['notes/deploy-key', `## Deploy\n\n${words(40, 'deploy')}\n\n${KEY}\n${words(20, 'after')}\n`]] as const) {
      await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: body, timeline: '', frontmatter: {} });
      await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_text: body.trim(), chunk_source: 'compiled_truth' }]);
    }
    await engine.executeRaw(`UPDATE pages SET chunker_version = 3 WHERE slug = 'notes/old-chunker'`);
    await engine.setConfig('version', '186');
  } finally {
    await engine.disconnect();
  }
}

async function postUpgrade(home: string, tty: boolean): Promise<{ exitCode: number; out: string }> {
  const env = keylessBrainEnv(process.env, home, {
    OPENAI_API_KEY: ['fixture', 'not', 'a', 'key'].join('-'),
    OPENAI_BASE_URL: `http://127.0.0.1:${provider.port}/v1`,
    GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_SKIP_REFERENCE_SWEEP: '1', GBRAIN_NO_AUTOPILOT_INSTALL: '1',
    DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined,
    // The PTY case stands in for a human at the terminal; CI runners set CI, which declines prompts unless GBRAIN_INTERACTIVE=1.
    GBRAIN_INTERACTIVE: tty ? '1' : undefined,
  });
  const cli = [process.execPath, '--no-env-file', join(REPO, 'src/cli.ts'), 'post-upgrade', '--no-autopilot-install'];
  const cmd = tty ? ['/usr/bin/script', '-qec', cli.map(a => `'${a.replace(/'/g, `'\\''`)}'`).join(' '), '/dev/null'] : cli;
  const proc = Bun.spawn({ cmd, env, cwd: home, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  // Every prompt gets the default answer (Enter); the stream stays open until the run ends.
  const answers = setInterval(() => { try { proc.stdin.write('\n'); proc.stdin.flush(); } catch { /* exited */ } }, 500);
  const kill = setTimeout(() => proc.kill(9), 170_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { exitCode, out: stdout + stderr };
  } finally {
    clearInterval(answers);
    clearTimeout(kill);
    try { proc.stdin.end(); } catch { /* closed */ }
  }
}

describe('post-upgrade with a configured embedding provider', () => {
  const homes: string[] = [];

  beforeAll(() => {
    configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
    provider = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        const path = new URL(req.url).pathname;
        if (!path.endsWith('/embeddings')) return new Response('not found', { status: 404 });
        embeddingCalls.push(path);
        const body = await req.json() as { input: string[] | string };
        const inputs = Array.isArray(body.input) ? body.input : [body.input];
        return Response.json({
          object: 'list', model: 'text-embedding-3-large', usage: { prompt_tokens: 1, total_tokens: 1 },
          data: inputs.map((_, index) => ({ object: 'embedding', index, embedding: Array.from({ length: LEGACY_EMBEDDING_CONFIG.embedding_dimensions }, () => 0.01) })),
        });
      },
    });
  });

  afterAll(() => {
    provider?.stop(true);
    resetGateway();
    for (const home of homes) rmSync(home, { recursive: true, force: true });
  });

  for (const tty of [false, true]) {
    test.skipIf(tty && !hasScript)(`${tty ? 'TTY (default answer)' : 'non-TTY'}: migrations finish, nothing is sent to the provider`, async () => {
      const home = mkdtempSync(join(tmpdir(), 'gbrain-upgrade-zero-provider-'));
      homes.push(home);
      await seedBrain(home);
      embeddingCalls.length = 0;
      const run = await postUpgrade(home, tty);
      expect(run.exitCode, run.out).toBe(0);
      expect(embeddingCalls, run.out).toEqual([]);
      expect(run.out).toContain('Not re-embedding without your consent');
      if (tty) expect(run.out).toContain('Re-embed now? [y/N]');
      const ledger = readFileSync(join(home, '.gbrain', 'migrations', 'completed.jsonl'), 'utf8');
      expect(ledger).toContain('"version":"0.60.31"');
      const engine = new PGLiteEngine();
      await engine.connect({ database_path: join(home, 'brain.pglite') });
      try {
        const [page] = await engine.executeRaw<{ sealed: boolean }>(`SELECT (text_projection_revision = knowledge_revision) IS TRUE AS sealed FROM pages WHERE slug = 'notes/deploy-key'`);
        expect(page.sealed).toBe(true);
        const chunks = await engine.getChunks('notes/deploy-key', { sourceId: 'default' });
        expect(chunks.map(c => c.chunk_text).join('\n')).not.toContain('PRIVATE KEY-----');
      } finally {
        await engine.disconnect();
      }
    }, 180_000);
  }
});
