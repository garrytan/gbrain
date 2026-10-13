/**
 * Cat 41 wave 2 consent negative: with provider keys in the environment and
 * `gbrain setup`'s provider-use decision recorded as declined, `gbrain doctor`
 * sent one unbilled `GET /v1/models` with the user's key in every run. The
 * request was OpenAI model discovery, which ran on every engine connect
 * (src/core/ai/openai-latest.ts). Now a recorded decline stops discovery and
 * the opt-in embedding probe, and doctor reports `provider_consent` as
 * skipped by consent with the fix that records acceptance. Since #6607
 * discovery runs only before an OpenAI-routed call, so plain doctor sends
 * nothing either way; the embedding probe is the OpenAI-routed call the
 * controls and the decline are measured on.
 *
 * Subprocess: `bun src/cli.ts` against a fresh PGLite home, OPENAI_BASE_URL
 * pointed at an in-process server that counts every request. The control runs
 * (no receipt) prove the counter sees the calls a decline must suppress.
 * Serial: spawns subprocesses, binds a port.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CONFIG_API_KEY_ENV } from '../src/core/ai/provider-env.ts';

const REPO = join(import.meta.dir, '..');
const KEY = ['sk', 'test', 'provider', 'consent', 'example'].join('-');

let home: string;
let requests: string[] = [];
let server: ReturnType<typeof Bun.serve>;

function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  for (const [, name] of CONFIG_API_KEY_ENV) delete env[name];
  for (const k of ['GEMINI_API_KEY', 'GBRAIN_MODEL_DISCOVERY', 'GBRAIN_DATABASE_URL', 'DATABASE_URL', 'GBRAIN_EMBEDDING_MODEL', 'OPENAI_BASE_URL', 'CLAUDE_CONFIG_DIR', 'GBRAIN_SOURCE']) delete env[k];
  return { ...env, HOME: home, GBRAIN_HOME: home, CODEX_HOME: join(home, 'codex'), ...extra };
}

async function gbrain(args: string[], extra: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, 'run', join(REPO, 'src', 'cli.ts'), ...args], {
    cwd: home, env: childEnv(extra), stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
  });
  const killer = setTimeout(() => proc.kill('SIGKILL'), 120_000);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(killer);
  return { code, stdout, stderr };
}

const providerEnv = () => ({ OPENAI_API_KEY: KEY, OPENAI_BASE_URL: `http://127.0.0.1:${server.port}/v1` });

function checksOf(stdout: string): Array<Record<string, unknown>> {
  const doc = JSON.parse(stdout.slice(stdout.indexOf('{'))) as { checks: Array<Record<string, unknown>> };
  return doc.checks;
}

function setConfig(patch: Record<string, unknown>, drop: string[] = []): void {
  const path = join(home, '.gbrain', 'config.json');
  const cfg = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  for (const k of drop) delete cfg[k];
  writeFileSync(path, JSON.stringify({ ...cfg, ...patch }));
}

/** What `gbrain setup claude-code` leaves beside ~/.claude.json. */
function writeReceipt(providers: 'accepted' | 'declined'): void {
  writeFileSync(join(home, '.gbrain-connection-claude-code-gbrain.json'), JSON.stringify({
    harness: 'claude-code', connection: 'local-stdio', setup_receipt_version: 1, status: 'installed', name: 'gbrain',
    gbrain_home: join(home, '.gbrain'), scope: 'user',
    consent: { providers: { value: providers, source: 'default' }, capture: { value: 'declined', source: 'default' } },
  }));
}

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      requests.push(`${req.method} ${new URL(req.url).pathname}`);
      if (new URL(req.url).pathname.endsWith('/embeddings')) {
        return Response.json({ object: 'list', data: [{ object: 'embedding', index: 0, embedding: new Array(1536).fill(0.01) }], model: 'text-embedding-3-large', usage: { prompt_tokens: 1, total_tokens: 1 } });
      }
      return Response.json({ object: 'list', data: [{ id: 'gpt-4o-mini', object: 'model' }] });
    },
  });
  home = mkdtempSync(join(tmpdir(), 'gb-pc-'));
  mkdirSync(join(home, 'codex'), { recursive: true });
  const init = await gbrain(['init', '--pglite', '--no-embedding']);
  expect(init.code).toBe(0);
}, 180_000);

afterAll(() => {
  server.stop(true);
  rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  requests = [];
  rmSync(join(home, '.gbrain', 'model-cache.json'), { force: true });
  rmSync(join(home, '.gbrain-connection-claude-code-gbrain.json'), { force: true });
  setConfig({ embedding_disabled: true }, ['embedding_model', 'embedding_dimensions']);
});

describe('doctor with provider keys present', () => {
  test('control: with no recorded decision, plain doctor sends nothing and an OpenAI-routed call discovers first (#6607)', async () => {
    const run = await gbrain(['doctor', '--json'], providerEnv());
    expect(requests).toEqual([]);
    setConfig({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536 }, ['embedding_disabled']);
    await gbrain(['doctor', '--only', 'embedding_provider', '--probe', '--yes', '--json'], providerEnv());
    expect(requests.slice(0, 2)).toEqual(['GET /v1/models', 'POST /v1/embeddings']);
    const check = checksOf(run.stdout).find((c) => c.name === 'provider_consent');
    expect(check?.status).toBe('ok');
    expect(check?.readiness_state).toBe('not_applicable');
  }, 180_000);

  test('setup declined provider use: zero outbound requests, provider check skipped by consent with a fix', async () => {
    writeReceipt('declined');
    const run = await gbrain(['doctor', '--json'], providerEnv());
    expect(requests).toEqual([]);
    const check = checksOf(run.stdout).find((c) => c.name === 'provider_consent')!;
    expect(check.status).toBe('ok');
    expect(check.severity).toBe('info');
    expect(check.readiness_state).toBe('disabled_by_choice');
    expect(String(check.message)).toContain('skipped by consent');
    expect(String(check.message)).toContain('OPENAI_API_KEY');
    expect(String(check.message)).not.toContain(KEY);
    const fix = check.fix as { argv: string[]; next: string; consent: string[] };
    expect(fix.argv).toEqual(['gbrain', 'setup', 'claude-code', '--providers']);
    expect(fix.consent).toEqual(['paid', 'egress']);
    expect(fix.next).not.toBe('run');
    expect((check.details as { provider_env: string[] }).provider_env).toEqual(['OPENAI_API_KEY']);
  }, 180_000);

  test('control: the opt-in embedding probe contacts the provider when no decision is recorded', async () => {
    setConfig({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536 }, ['embedding_disabled']);
    await gbrain(['doctor', '--only', 'embedding_provider', '--probe', '--yes', '--json'], { ...providerEnv(), GBRAIN_MODEL_DISCOVERY: 'off' });
    expect(requests).toContain('POST /v1/embeddings');
  }, 180_000);

  test('setup declined provider use: even `--probe --yes` sends nothing and reports the probe skipped by consent', async () => {
    writeReceipt('declined');
    setConfig({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536 }, ['embedding_disabled']);
    const run = await gbrain(['doctor', '--only', 'embedding_provider', '--probe', '--yes', '--json'], providerEnv());
    expect(requests).toEqual([]);
    const check = checksOf(run.stdout).find((c) => c.name === 'embedding_provider')!;
    expect(check.readiness_state).toBe('disabled_by_choice');
    expect(String(check.message)).toContain('skipped by consent');
    expect((check.fix as { argv: string[] }).argv).toEqual(['gbrain', 'setup', 'claude-code', '--providers']);
  }, 180_000);

  test('setup accepted provider use: discovery runs before the first OpenAI-routed call', async () => {
    writeReceipt('accepted');
    const run = await gbrain(['doctor', '--json'], providerEnv());
    expect(requests).toEqual([]);
    setConfig({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536 }, ['embedding_disabled']);
    await gbrain(['doctor', '--only', 'embedding_provider', '--probe', '--yes', '--json'], providerEnv());
    expect(requests).toContain('GET /v1/models');
    expect(checksOf(run.stdout).find((c) => c.name === 'provider_consent')?.details).toMatchObject({ decision: 'accepted' });
  }, 180_000);
});
