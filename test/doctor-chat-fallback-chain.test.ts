/**
 * `chat_fallback_chain` doctor check (fix wave lane B3, W-B3).
 *
 * Protects: doctor reports the effective chain, the plane that wins (env >
 * config.json > DB), shadowed values, the providers that receive traffic and
 * whether refusals fall back; an active chain is an informational `ok` whose
 * removal guidance is never `next: run` (DB: ask_user; env: tell_user_to_run;
 * file: names the path and key); malformed entries or plane values, missing
 * provider credentials and unpriced models under a user-set cap are `warn`
 * with a cause-specific fix; the remote report hides entries and providers;
 * the check is in the local registry, `--only` and the remote report; it makes
 * no network or subprocess call.
 * Fails when: any of those diagnoses, plane decisions or redactions regress.
 * Seams: a real PGLite brain (DB plane), a throwaway GBRAIN_HOME (file plane).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { checkChatFallbackChain } from '../src/commands/doctor/checks/chat-fallback.ts';
import { finalizeCheckFixes } from '../src/commands/doctor/check-fix.ts';
import { doctorCheckNames, onlyNeedsEngine } from '../src/commands/doctor/registry.ts';
import { doctorReportRemote } from '../src/commands/doctor/report-remote.ts';
import { _resetDbPlaneMergeMemoForTests } from '../src/core/config-db-merge.ts';
import { withEnv } from './helpers/with-env.ts';

const FALLBACK = 'openai:gpt-5.6-luna';
const SECOND = 'deepseek:deepseek-v4-flash';

let engine: PGLiteEngine;
let fetchSpy: ReturnType<typeof spyOn>;
let spawnSpy: ReturnType<typeof spyOn>;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  for (const k of ['chat_fallback_chain', 'chat_fallback_on_refusal', 'facts.drain_budget_usd', 'pricing.overrides']) await engine.unsetConfig(k);
  _resetDbPlaneMergeMemoForTests();
  fetchSpy = spyOn(globalThis, 'fetch');
  spawnSpy = spyOn(Bun, 'spawn');
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(spawnSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
  spawnSpy.mockRestore();
});

function home(file: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-doctor-chain-'));
  mkdirSync(join(dir, '.gbrain'), { recursive: true });
  writeFileSync(join(dir, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: join(dir, 'brain.pglite'), ...file }));
  return dir;
}

const ENV_BASE = {
  GBRAIN_CHAT_FALLBACK_CHAIN: undefined, GBRAIN_CHAT_FALLBACK_ON_REFUSAL: undefined, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined,
  OPENAI_API_KEY: 'fake-openai', DEEPSEEK_API_KEY: 'fake-deepseek', ANTHROPIC_API_KEY: undefined, GBRAIN_CLAUDE_CLI_BIN: undefined,
};

async function run(env: Record<string, string | undefined>, file: Record<string, unknown> = {}, remote = false) {
  return withEnv({ ...ENV_BASE, GBRAIN_HOME: home(file), ...env }, async () => {
    const [check] = finalizeCheckFixes([await checkChatFallbackChain(engine, { remote })]);
    return check!;
  });
}

describe('chat_fallback_chain doctor check', () => {
  test('no chain anywhere is a plain ok', async () => {
    const c = await run({});
    expect(c.status).toBe('ok');
    expect(c.message).toContain('No chat_fallback_chain is set');
    expect(c.fix).toBeUndefined();
  });

  test('a DB chain is an informational ok: entries, providers, refusal fallback, ask_user removal', async () => {
    await engine.setConfig('chat_fallback_chain', `${FALLBACK}, ${SECOND}`);
    const c = await run({});
    expect(c.status).toBe('ok');
    expect(c.message).toContain(`${FALLBACK} -> ${SECOND}`);
    expect(c.message).toContain('the brain database');
    expect(c.message).toContain('openai, deepseek');
    expect(c.message).toContain('on refusals');
    expect(c.details).toMatchObject({ plane: 'db', chain: [FALLBACK, SECOND], providers: ['openai', 'deepseek'], on_refusal: { value: true, plane: 'default' } });
    const fix = c.fix as { argv: string[]; next: string; consent: string[] };
    expect(fix.argv).toEqual(['gbrain', 'config', 'unset', 'chat_fallback_chain']);
    expect(fix.next).toBe('ask_user');
  });

  test('env wins over the DB, the DB value is reported shadowed, and env removal is the user\'s (restart named)', async () => {
    await engine.setConfig('chat_fallback_chain', SECOND);
    const c = await run({ GBRAIN_CHAT_FALLBACK_CHAIN: FALLBACK });
    expect(c.status).toBe('ok');
    expect(c.details).toMatchObject({ plane: 'env', chain: [FALLBACK], shadowed: [{ plane: 'db', chain: [SECOND] }] });
    expect(c.message).toContain('Shadowed');
    const fix = c.fix as { argv: string[]; next: string; why: string };
    expect(fix.argv).toEqual(['unset', 'GBRAIN_CHAT_FALLBACK_CHAIN']);
    expect(fix.next).toBe('tell_user_to_run');
    expect(fix.why).toContain('restarts');
  });

  test('config.json wins over the DB and the guidance names the file and key, never run', async () => {
    await engine.setConfig('chat_fallback_chain', SECOND);
    const c = await run({}, { chat_fallback_chain: [FALLBACK], chat_fallback_on_refusal: false });
    expect(c.details).toMatchObject({ plane: 'file', chain: [FALLBACK], shadowed: [{ plane: 'db', chain: [SECOND] }], on_refusal: { value: false, plane: 'file' } });
    expect(c.message).toContain('errors only');
    const fix = c.fix as { next: string; user_message: string };
    expect(fix.next).not.toBe('run');
    expect(fix.user_message).toContain('"chat_fallback_chain"');
    expect(fix.user_message).toContain('config.json');
  });

  test('a bare model name is a malformed entry', async () => {
    await engine.setConfig('chat_fallback_chain', `${FALLBACK}, gpt-5`);
    const c = await run({});
    expect(c.status).toBe('warn');
    expect(c.message).toContain('gpt-5 (malformed)');
    expect((c.fix as { next: string }).next).toBe('ask_user');
  });

  test('an unknown provider is named as such', async () => {
    await engine.setConfig('chat_fallback_chain', 'acme-example:model-1');
    const c = await run({});
    expect(c.status).toBe('warn');
    expect(c.message).toContain('unknown_provider');
  });

  test('a DB value that is not valid JSON says it cannot be read', async () => {
    await engine.setConfig('chat_fallback_chain', '["openai:gpt-5.6-luna"');
    const c = await run({});
    expect(c.status).toBe('warn');
    expect(c.message).toContain('cannot be read');
    expect(c.message).toContain('not valid JSON');
  });

  test('a provider with no credential present gets a credential fix', async () => {
    await engine.setConfig('chat_fallback_chain', 'anthropic:claude-sonnet-4-6');
    const c = await run({});
    expect(c.status).toBe('warn');
    expect(c.message).toContain('no_credential');
    expect(c.message).toContain('ANTHROPIC_API_KEY');
    expect((c.fix as { consent: string[] }).consent).toEqual(['credentials']);
  });

  test('claude-cli checks for its binary, not a login probe', async () => {
    await engine.setConfig('chat_fallback_chain', 'claude-cli:claude-sonnet-4-6');
    const c = await run({ GBRAIN_CLAUDE_CLI_BIN: '/nonexistent/claude-example' });
    expect(c.status).toBe('warn');
    expect(c.message).toContain('claude CLI binary');
  });

  test('an unpriced model under a user-set cap gets the pricing registration fix; without a cap it is ok', async () => {
    await engine.setConfig('chat_fallback_chain', 'openai:acme-unpriced-model');
    expect((await run({})).status).toBe('ok');
    await engine.setConfig('facts.drain_budget_usd', '2');
    const c = await run({});
    expect(c.status).toBe('warn');
    expect(c.message).toContain('unpriced_under_cap');
    expect((c.fix as { argv: string[] }).argv.slice(0, 4)).toEqual(['gbrain', 'pricing', 'set', 'openai:acme-unpriced-model']);
  });

  test('the remote view says a chain is configured without entries or providers', async () => {
    await engine.setConfig('chat_fallback_chain', `${FALLBACK}, ${SECOND}`);
    const c = await run({}, {}, true);
    expect(c.status).toBe('ok');
    expect(c.message).toContain('A chat fallback chain is configured');
    expect(c.message).not.toContain('gpt-5.6-luna');
    expect(c.message).not.toContain('openai');
    expect(c.details).toBeUndefined();
    expect((c.fix as { actor: string }).actor).toBe('host_admin');
  });
});

describe('registration', () => {
  test('the local registry and --only know the check, and --only connects the brain so the DB plane is read', () => {
    expect(doctorCheckNames().has('chat_fallback_chain')).toBe(true);
    expect(onlyNeedsEngine(new Set(['chat_fallback_chain']))).toBe(true);
    expect(onlyNeedsEngine(new Set(['behavior_changes']))).toBe(true);
  });

  test('the remote report carries the check, redacted', async () => {
    await engine.setConfig('chat_fallback_chain', FALLBACK);
    await withEnv({ ...ENV_BASE, GBRAIN_HOME: home() }, async () => {
      const report = await doctorReportRemote(engine, { remote: true });
      const c = report.checks.find(x => x.name === 'chat_fallback_chain');
      expect(c?.message).toContain('A chat fallback chain is configured');
      expect(JSON.stringify(c)).not.toContain('gpt-5.6-luna');
    });
  }, 60_000);
});
