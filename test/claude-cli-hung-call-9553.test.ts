/**
 * #9553: a `claude` child that never answers. The stub at
 * GBRAIN_CLAUDE_CLI_BIN reads stdin, records its pid, then sleeps for ten
 * minutes without printing an envelope.
 *
 * The calls go through extractFactsFromTurnWithOutcome, the function the
 * conversation-facts backfill uses (conversation-window-extract.ts passes the
 * backfill's per-source deadline signal as `abortSignal`), and from there
 * through gateway chat() to ClaudeCliLanguageModel.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { extractFactsFromTurnWithOutcome } from '../src/core/facts/extract.ts';
import { withEnv } from './helpers/with-env.ts';

const MODEL = 'claude-cli:claude-sonnet-4-6';
const RACE_MS = 3_000;
const stubDir = join(tmpdir(), `claude-cli-hung-9553-${process.pid}`);
const stubBin = join(stubDir, 'claude');
const pidPath = join(stubDir, 'pid');
const src = (p: string) => JSON.stringify(join(import.meta.dir, '../src', p));

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const stubPid = () => (existsSync(pidPath) ? Number(readFileSync(pidPath, 'utf8').trim()) : 0);

beforeAll(() => {
  mkdirSync(stubDir, { recursive: true });
  writeFileSync(stubBin, [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then echo "2.1.316 (Claude Code)"; exit 0; fi',
    `echo $$ > "${pidPath}"`,
    'cat > /dev/null',
    'exec sleep 600',
  ].join('\n') + '\n');
  chmodSync(stubBin, 0o755);
});
afterEach(() => {
  const pid = stubPid();
  if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
  rmSync(pidPath, { force: true });
  resetGateway();
});
afterAll(() => rmSync(stubDir, { recursive: true, force: true }));

async function race(abortSignal?: AbortSignal): Promise<{ settled: 'timeout' | 'resolved' | 'rejected'; ms: number; childAlive: boolean }> {
  configureGateway({ chat_model: MODEL, env: {} });
  return withEnv({ GBRAIN_CLAUDE_CLI_BIN: stubBin }, async () => {
    const started = Date.now();
    const call = extractFactsFromTurnWithOutcome({
      turnText: 'alice-example said acme-example closed its seed round last week.',
      source: 'test:9553',
      model: MODEL,
      abortSignal,
    }).then(() => 'resolved' as const, () => 'rejected' as const);
    const settled = await Promise.race([call, sleep(RACE_MS).then(() => 'timeout' as const)]);
    const ms = Date.now() - started;
    await sleep(200);
    const pid = stubPid();
    return { settled, ms, childAlive: pid > 0 && alive(pid) };
  });
}

/**
 * GBRAIN_AI_CHAT_TIMEOUT_MS is read once when gateway.ts loads, so the
 * shortened default backstop runs in a fresh bun process.
 */
function extractUnderOneSecondBackstop(model: string, gatewayExtra: string, preamble = ''): { ms: number; ok?: boolean; reason?: string; error?: string; thrown?: string } {
  const script = [
    `import { configureGateway } from ${src('core/ai/gateway.ts')};`,
    `import { extractFactsFromTurnWithOutcome } from ${src('core/facts/extract.ts')};`,
    preamble,
    `configureGateway({ chat_model: ${JSON.stringify(model)}, env: {}${gatewayExtra} });`,
    'const t = Date.now();',
    `const out = await extractFactsFromTurnWithOutcome({ turnText: 'alice-example joined acme-example.', source: 'test:9553', model: ${JSON.stringify(model)} }).then(o => o, e => ({ thrown: String(e) }));`,
    'console.log(JSON.stringify({ ms: Date.now() - t, ok: out.ok, reason: out.reason, error: out.error ? String(out.error) : undefined, thrown: out.thrown }));',
    'process.exit(0);',
  ].join('\n');
  const r = Bun.spawnSync([process.execPath, '-e', script], {
    env: { ...process.env, GBRAIN_CLAUDE_CLI_BIN: stubBin, GBRAIN_AI_CHAT_TIMEOUT_MS: '1000' },
    timeout: 15_000,
  });
  const line = r.stdout.toString().trim().split('\n').pop() ?? '';
  console.log(`[${model}] outcome under a 1 s chat backstop: ${line}`);
  return JSON.parse(line);
}

describe('claude-cli call whose child never answers (#9553)', () => {
  test('a caller deadline (the backfill per-source walltime signal) cuts the call off mid-flight and kills the child', async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('conversation_facts_backfill: per-source walltime cap (1min) hit for source-a')), 1_000);
    const r = await race(controller.signal);
    clearTimeout(timer);
    expect(r.settled).toBe('rejected');
    expect(r.ms).toBeLessThan(RACE_MS);
    expect(r.childAlive).toBe(false);
  }, 10_000);

  test('the default chat backstop cuts a claude-cli call off and records it as a failed call, like an HTTP provider', async () => {
    const out = extractUnderOneSecondBackstop(MODEL, '');
    await sleep(200);
    expect(out.ms).toBeLessThan(RACE_MS);
    expect(alive(stubPid())).toBe(false);
    expect(out.thrown).toBeUndefined();
    expect(out.reason).toBe('provider_error');
  }, 20_000);

  test('control: an HTTP provider that never answers is recorded as provider_error at the same backstop', () => {
    const out = extractUnderOneSecondBackstop(
      'ollama:llama3.1',
      `, base_urls: { ollama: 'http://127.0.0.1:' + server.port + '/v1' }`,
      'const server = Bun.serve({ port: 0, fetch: () => new Promise(() => {}) });',
    );
    expect(out.ms).toBeLessThan(RACE_MS);
    expect(out.thrown).toBeUndefined();
    expect(out.reason).toBe('provider_error');
  }, 20_000);
});
