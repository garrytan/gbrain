/**
 * `subscription_routing` doctor check.
 *
 * Protects: the check is registered (local registry, `--only` connects the
 * brain) and categorized; with no `models.route` it is an informational ok;
 * with the claude-cli preset applied on a keyless brain it is ok and reports
 * the embedding standing; a per-task key pointing elsewhere turns it into a
 * warn that names the surface and says whether it bills or fails; the re-apply
 * fix (behind `paid` consent) is offered only when every leaving surface is a
 * key the preset writes, otherwise the fix asks the user and names each key
 * to change; an unknown marker warns with an unset fix; the remote report
 * (and `doctorReportRemote`, i.e. MCP run_doctor) hides the surface list and
 * points the host operator at the local check; no network or subprocess call
 * is made.
 * Fails when: the entry is dropped from the registry or its category, the
 * marker gate inverts, a leaving surface is not named, the fix loses its
 * consent, a re-apply is offered that cannot clear the warning, or the remote
 * report drops the check.
 * Existing coverage: none — the check is new.
 * Seams: a real PGLite brain (DB plane), a throwaway GBRAIN_HOME.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { checkSubscriptionRouting } from '../src/commands/doctor/checks/subscription-routing.ts';
import { finalizeCheckFixes } from '../src/commands/doctor/check-fix.ts';
import { doctorCheckNames, onlyNeedsEngine } from '../src/commands/doctor/registry.ts';
import { categorizeCheck } from '../src/core/doctor-categories.ts';
import { doctorReportRemote } from '../src/commands/doctor/report-remote.ts';
import { CLAUDE_CLI_ROUTE_PRESET, ROUTE_MARKER_KEY, ROUTE_UNDO_KEY } from '../src/commands/models-route.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let fetchSpy: ReturnType<typeof spyOn>;
let spawnSpy: ReturnType<typeof spyOn>;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  for (const k of [...CLAUDE_CLI_ROUTE_PRESET.keys.map(k => k.key), ROUTE_MARKER_KEY, ROUTE_UNDO_KEY, 'models.dream.synthesize', 'chat_fallback_chain', 'search.reranker.model']) await engine.unsetConfig(k);
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
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-doctor-route-'));
  mkdirSync(join(dir, '.gbrain'), { recursive: true });
  writeFileSync(join(dir, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: join(dir, 'brain.pglite'), ...file }));
  return dir;
}

const ENV_BASE = {
  ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined, GOOGLE_API_KEY: undefined, GEMINI_API_KEY: undefined,
  GBRAIN_MODEL: undefined, GBRAIN_CHAT_FALLBACK_CHAIN: undefined, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined,
};

async function run(env: Record<string, string | undefined> = {}, file: Record<string, unknown> = {}, remote = false) {
  return withEnv({ ...ENV_BASE, GBRAIN_HOME: home(file), ...env }, async () => {
    const [check] = finalizeCheckFixes([await checkSubscriptionRouting(engine, { remote })]);
    return check!;
  });
}

async function applyPreset(): Promise<void> {
  for (const k of CLAUDE_CLI_ROUTE_PRESET.keys) await engine.setConfig(k.key, k.value);
  await engine.setConfig(ROUTE_MARKER_KEY, 'claude-cli');
}

describe('subscription_routing doctor check', () => {
  test('is registered, engine-only under --only, and categorized', () => {
    expect(doctorCheckNames().has('subscription_routing')).toBe(true);
    expect(onlyNeedsEngine(new Set(['subscription_routing']))).toBe(true);
    expect(categorizeCheck('subscription_routing')).toBe('ops');
  });

  test('no models.route is an informational ok', async () => {
    const c = await run();
    expect(c.status).toBe('ok');
    expect(c.severity).toBe('info');
    expect(c.message).toContain('gbrain models route claude-cli');
  });

  test('the applied preset on a keyless brain is ok and reports the embedding standing', async () => {
    await applyPreset();
    const c = await run({}, { embedding_model: 'ollama:nomic-embed-text' });
    expect(c.message).not.toContain('reranker →');
    expect(c.status).toBe('ok');
    expect(c.message).toContain('stays on claude-cli');
    expect(c.message).toContain('nightly probe is off');
    expect((c.details as { embedding: { standing: string } }).embedding.standing).toBe('local');
    expect((c.details as { leaving: unknown[] }).leaving).toEqual([]);
  });

  test('a preset-owned key moved off the route is a warn with the re-apply fix behind paid consent', async () => {
    await applyPreset();
    await engine.setConfig('models.tier.deep', 'anthropic:claude-opus-5-5');
    const c = await run({}, { embedding_model: 'openai:text-embedding-3-small' });
    expect(c.status).toBe('warn');
    expect(c.message).toContain('tier.deep → anthropic:claude-opus-5-5');
    expect(c.message).toContain('fails: no ANTHROPIC_API_KEY');
    expect(c.message).toContain('OPENAI_API_KEY is absent');
    expect(c.fix?.argv).toEqual(['gbrain', 'models', 'route', 'claude-cli', '--apply']);
    expect(c.fix?.consent).toEqual(['paid']);

    // The re-apply fix resolves it: verify comes back ok.
    for (const k of CLAUDE_CLI_ROUTE_PRESET.keys) await engine.setConfig(k.key, k.value);
    expect((await run({}, { embedding_model: 'openai:text-embedding-3-small' })).status).toBe('ok');
  });

  test('a key the preset does not own gets no runnable re-apply: the fix asks the user and names what to change', async () => {
    await applyPreset();
    await engine.setConfig('models.dream.synthesize', 'anthropic:claude-sonnet-4-6');
    const c = await run({}, { embedding_model: 'openai:text-embedding-3-small' });
    expect(c.status).toBe('warn');
    expect(c.message).toContain('models.dream.synthesize → anthropic:claude-sonnet-4-6');
    expect(c.fix?.argv).toBeUndefined();
    expect((c.fix as { next?: string } | undefined)?.next).toBe('ask_user');
    expect(c.fix?.user_message).toContain('models.dream.synthesize [config: models.dream.synthesize]');
    expect(c.fix?.verify?.argv).toEqual(['gbrain', 'doctor', '--only', 'subscription_routing', '--json']);

    // Mixed: an owned key alongside an unowned one still cannot be fixed by the re-apply alone.
    await engine.setConfig('models.tier.deep', 'anthropic:claude-opus-5-5');
    const mixed = await run();
    expect(mixed.fix?.argv).toBeUndefined();
    expect(mixed.fix?.user_message).toContain('gbrain models route claude-cli --apply');

    const keyed = await run({ ANTHROPIC_API_KEY: 'sk-test-not-real' });
    expect(keyed.status).toBe('warn');
    expect(keyed.message).toContain('(bills anthropic)');
  });

  test('an unknown marker warns with an unset fix', async () => {
    await engine.setConfig(ROUTE_MARKER_KEY, 'not-a-preset');
    const c = await run();
    expect(c.status).toBe('warn');
    expect(c.fix?.argv).toEqual(['gbrain', 'config', 'unset', ROUTE_MARKER_KEY]);
  });

  test('the remote report says only that a route is set and how many surfaces leave it', async () => {
    await applyPreset();
    await engine.setConfig('models.dream.synthesize', 'anthropic:claude-sonnet-4-6');
    const c = await run({}, {}, true);
    expect(c.status).toBe('warn');
    expect(c.message).toContain('1 model surface(s) leave it');
    expect(c.message).not.toContain('models.dream.synthesize');
    expect(c.details).toBeUndefined();
    expect(c.fix?.argv).toEqual(['gbrain', 'doctor', '--only', 'subscription_routing']);
    expect(c.fix?.actor).toBe('host_admin');
  });

  test('the remote doctor report (run_doctor) carries the check, redacted', async () => {
    await applyPreset();
    await engine.setConfig('models.dream.synthesize', 'anthropic:claude-sonnet-4-6');
    await withEnv({ ...ENV_BASE, GBRAIN_HOME: home() }, async () => {
      const report = await doctorReportRemote(engine, { remote: true });
      const c = report.checks.find(x => x.name === 'subscription_routing');
      expect(c?.message).toContain('1 model surface(s) leave it');
      expect(JSON.stringify(c)).not.toContain('claude-sonnet-4-6');
    });
  }, 60_000);
});
