/**
 * GBRA-219: memory writeback settings over MCP. Every case runs on a keyless,
 * in-memory PGLite brain with no git repository (repo-less brains are first
 * class): the settings live in the config table and the audit row in the
 * request log.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { operations } from '../src/core/operations.ts';
import { disabledOpsForPublishGates } from '../src/mcp/publish-gates.ts';
import { isCallable } from '../src/core/ops/callable.ts';
import { buildMcpInstructions } from '../src/mcp/instructions.ts';
import { buildAmbientWritebackSection } from '../src/core/facts/writeback-instructions.ts';
import { ambientOptsFrom, captureLaneStates, resolveWritebackConfig } from '../src/core/facts/writeback-config.ts';
import { resolveAgentWriteback } from '../src/core/facts/writeback-settings.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import type { GBrainConfig } from '../src/core/config.ts';

const CONFIG = { engine: 'pglite' } as GBrainConfig;
let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

const auth = (scopes: string[], extra: Partial<AuthInfo> = {}): AuthInfo => ({ token: 't', clientId: 'client-a', scopes, ...extra }) as AuthInfo;

async function call(name: string, params: Record<string, unknown>, opts: { scopes?: string[]; auth?: AuthInfo; remote?: boolean } = {}) {
  const res = await dispatchToolCall(engine, name, params, {
    remote: opts.remote ?? true,
    transport: 'http',
    config: CONFIG,
    auth: opts.auth ?? auth(opts.scopes ?? ['admin']),
    sourceId: 'default',
  });
  return { isError: res.isError === true, body: JSON.parse(res.content[0].text) as Record<string, any> };
}

async function auditRows(): Promise<Array<{ params: Record<string, unknown> }>> {
  return engine.executeRaw(`SELECT params FROM mcp_request_log WHERE operation = 'memory_setting_change' ORDER BY id`) as never;
}

const op = (name: string) => operations.find(o => o.name === name)!;

describe('set_memory_writeback: operator grant + admin scope', () => {
  test('gate unset: hidden from the catalog and refused at call time; nothing written', async () => {
    const disabled = await disabledOpsForPublishGates(engine, CONFIG);
    expect(disabled.has('set_memory_writeback')).toBe(true);
    const gates = { 'mcp.publish_memory_settings': false };
    expect(isCallable(op('set_memory_writeback'), { transport: 'http', surface: 'full', scopes: ['admin'], publishGates: gates })).toBe(false);
    const res = await call('set_memory_writeback', { mode: 'all' });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.body)).toContain('mcp.publish_memory_settings');
    expect(await engine.getConfig('memory.agent_writeback')).toBeNull();
    expect(await auditRows()).toHaveLength(0);
  });

  test('gate on: write scope is not enough, admin scope changes only the agent override', async () => {
    await engine.setConfig('mcp.publish_memory_settings', 'true');
    expect(isCallable(op('set_memory_writeback'), { transport: 'http', surface: 'full', scopes: ['read', 'write'], publishGates: { 'mcp.publish_memory_settings': true } })).toBe(false);
    const denied = await call('set_memory_writeback', { mode: 'all' }, { scopes: ['read', 'write'] });
    expect(denied.isError).toBe(true);
    expect(await engine.getConfig('memory.agent_writeback')).toBeNull();

    const ok = await call('set_memory_writeback', { mode: 'salient' });
    expect(ok.isError).toBe(false);
    expect(ok.body.applied).toBe(true);
    expect(ok.body.background_capture_unchanged).toBe(true);
    expect(await engine.getConfig('memory.agent_writeback')).toBe('salient');
    expect(await engine.getConfig('memory.auto_writeback')).toBeNull();
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].params).toMatchObject({ key: 'memory.agent_writeback', actor: 'client-a', old: null, new: 'salient', transport: 'http' });
  });

  test('remote off then remote salient never moves the host capture lanes', async () => {
    await engine.setConfig('mcp.publish_memory_settings', 'true');
    await engine.setConfig('memory.auto_writeback', 'salient');
    const before = captureLaneStates(await resolveWritebackConfig(engine, CONFIG, { gate: true }));
    expect((await call('set_memory_writeback', { mode: 'off' })).isError).toBe(false);
    expect(captureLaneStates(await resolveWritebackConfig(engine, CONFIG, { gate: true }))).toEqual(before);
    expect((await call('set_memory_writeback', { mode: 'salient' })).isError).toBe(false);
    expect(captureLaneStates(await resolveWritebackConfig(engine, CONFIG, { gate: true }))).toEqual(before);
    expect(await engine.getConfig('memory.auto_writeback')).toBe('salient');
  });

  test('a restrictive override says background capture keeps running', async () => {
    await engine.setConfig('mcp.publish_memory_settings', 'true');
    await engine.setConfig('memory.auto_writeback', 'all');
    const res = await call('set_memory_writeback', { mode: 'off' });
    expect(res.body.effective_mode).toBe('off');
    expect(res.body.note).toContain('keeps running');
  });

  test('dry_run writes neither the setting nor an audit row', async () => {
    await engine.setConfig('mcp.publish_memory_settings', 'true');
    const res = await call('set_memory_writeback', { mode: 'all', dry_run: true });
    expect(res.body).toMatchObject({ applied: false, dry_run: true, requested: 'all', previous: 'inherit' });
    expect(await engine.getConfig('memory.agent_writeback')).toBeNull();
    expect(await auditRows()).toHaveLength(0);
  });

  test('setting and audit commit together: a failed audit insert leaves the setting unchanged and says the outcome is unknown', async () => {
    await engine.setConfig('mcp.publish_memory_settings', 'true');
    await engine.executeRaw('ALTER TABLE mcp_request_log RENAME TO mcp_request_log_gone');
    let res: Awaited<ReturnType<typeof call>>;
    try {
      res = await call('set_memory_writeback', { mode: 'all' });
    } finally {
      await engine.executeRaw('ALTER TABLE mcp_request_log_gone RENAME TO mcp_request_log');
    }
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.body)).toContain('memory_setting_write_outcome_unknown');
    expect(JSON.stringify(res.body)).toContain('get_memory_settings');
    expect(await engine.getConfig('memory.agent_writeback')).toBeNull();
  });

  test('the trusted local CLI needs no grant', async () => {
    const res = await call('set_memory_writeback', { mode: 'all' }, { remote: false });
    expect(res.isError).toBe(false);
    expect(await engine.getConfig('memory.agent_writeback')).toBe('all');
  });
});

describe('resolveAgentWriteback: the override never widens on doubt', () => {
  test('inherit and unset follow the operator; a valid override wins', async () => {
    await engine.setConfig('memory.auto_writeback', 'salient');
    expect((await resolveAgentWriteback(engine, CONFIG)).bundle.mode).toBe('salient');
    await engine.setConfig('memory.agent_writeback', 'inherit');
    expect((await resolveAgentWriteback(engine, CONFIG)).bundle.mode).toBe('salient');
    await engine.setConfig('memory.agent_writeback', 'off');
    const off = await resolveAgentWriteback(engine, CONFIG);
    expect(off.bundle).toMatchObject({ mode: 'off', enabled: false });
    expect(off.operator.mode).toBe('salient');
    expect(off.status).toBe('ok');
  });

  test('an unrecognized override fails closed to off, degraded', async () => {
    await engine.setConfig('memory.auto_writeback', 'all');
    await engine.setConfig('memory.agent_writeback', 'everything');
    const r = await resolveAgentWriteback(engine, CONFIG);
    expect(r).toMatchObject({ source: 'fail_closed', status: 'degraded' });
    expect(r.bundle.mode).toBe('off');
    expect(r.reasons).toContain('agent_override_invalid');
  });

  test('an unreadable override with no last-known-good fails closed to off', async () => {
    const real = engine.getConfig.bind(engine);
    const flaky = Object.create(engine) as PGLiteEngine;
    flaky.getConfig = async (key: string) => {
      if (key === 'memory.agent_writeback') throw new Error('config read failed');
      return key === 'memory.auto_writeback' ? 'all' : real(key);
    };
    const r = await resolveAgentWriteback(flaky, CONFIG);
    expect(r.bundle.mode).toBe('off');
    expect(r.reasons).toContain('agent_override_unreadable');
  });
});

describe('resolveAgentWriteback: cold failures', () => {
  test('an operator read failure with no last-known-good never emits an enabled rule on default posture', async () => {
    await engine.setConfig('memory.agent_writeback', 'all');
    await engine.setConfig('facts.default_visibility', 'private');
    const real = engine.getConfig.bind(engine);
    const cold = Object.create(engine) as PGLiteEngine;
    cold.getConfig = async (key: string) => {
      if (key === 'facts.default_visibility' || key === 'memory.auto_writeback') throw new Error('config read failed');
      return real(key);
    };
    const r = await resolveAgentWriteback(cold, CONFIG);
    expect(r.bundle.enabled).toBe(false);
    expect(r).toMatchObject({ source: 'fail_closed', status: 'degraded' });
  });

  test('a confirmed restrictive write replaces the cached override, so a later read failure cannot revive the old one', async () => {
    await engine.setConfig('mcp.publish_memory_settings', 'true');
    await call('set_memory_writeback', { mode: 'all' });
    expect((await resolveAgentWriteback(engine, CONFIG)).bundle.mode).toBe('all');
    await call('set_memory_writeback', { mode: 'off' }, { remote: false });
    const real = engine.getConfig;
    engine.getConfig = async (key: string) => {
      if (key === 'memory.agent_writeback') throw new Error('config read failed');
      return real.call(engine, key);
    };
    try {
      expect((await resolveAgentWriteback(engine, CONFIG)).bundle.mode).toBe('off');
    } finally {
      engine.getConfig = real;
    }
  });
});

describe('get_memory_settings', () => {
  test('rule text matches what initialize renders; off has none; every mode is previewable', async () => {
    const off = await call('get_memory_settings', {}, { scopes: ['read', 'write'] });
    expect(off.body.effective_mode).toBe('off');
    expect(off.body.rule_text).toBeNull();
    expect(off.body.rule_texts.salient).toContain('mode: salient');
    expect(off.body.rule_texts.all).toContain('mode: all');
    expect(off.body.operator_mode).toEqual({ mode: 'off', explicit: false });

    await engine.setConfig('memory.agent_writeback', 'salient');
    const on = await call('get_memory_settings', {}, { scopes: ['read', 'write'] });
    const bundle = (await resolveAgentWriteback(engine, CONFIG)).bundle;
    const rendered = buildMcpInstructions({ writeback: ambientOptsFrom(bundle, { remember: true, extractFacts: true }) });
    expect(on.body.rule_text).toBe(buildAmbientWritebackSection({ mode: 'salient', transientTtl: '3d', visibility: 'world', extractFactsAvailable: true }));
    expect(rendered).toContain(on.body.rule_text);
    expect(on.body.source).toBe('agent_override');
  });

  test('can_set names the missing grant with the operator command; conversation switch needs remember', async () => {
    const reader = await call('get_memory_settings', {}, { scopes: ['read'] });
    expect(reader.body.can_set).toMatchObject({ allowed: false, blocked_by: ['gate_off', 'scope'] });
    expect(JSON.stringify(reader.body.can_set.fix)).toContain('mcp.publish_memory_settings');
    expect(reader.body.conversation_switch.available).toBe(false);
    expect(reader.body.rule_text).toBeNull();

    await engine.setConfig('mcp.publish_memory_settings', 'true');
    const writer = (await call('get_memory_settings', {}, { scopes: ['read', 'write'] })).body.can_set;
    expect(writer).toMatchObject({ allowed: false, blocked_by: ['scope'] });
    expect(writer.fix).toBeUndefined();
    expect((await call('get_memory_settings', {})).body.can_set).toEqual({ allowed: true });
  });

  test('a degraded read says so instead of reporting a plain off', async () => {
    await engine.setConfig('memory.agent_writeback', 'bogus');
    const res = await call('get_memory_settings', {}, { scopes: ['read'] });
    expect(res.body.status).toBe('degraded');
    expect(res.body.note).toContain('not proof');
  });
});

describe('memory_conversation_mode', () => {
  test('all returns a conversation rule with the brain\'s private posture, even when the operator set off; nothing is stored', async () => {
    await engine.setConfig('memory.auto_writeback', 'off');
    await engine.setConfig('facts.default_visibility', 'private');
    const before = await engine.executeRaw('SELECT key, value FROM config ORDER BY key');
    const res = await call('memory_conversation_mode', { mode: 'all' }, { scopes: ['read', 'write'] });
    expect(res.isError).toBe(false);
    expect(res.body).toMatchObject({ mode: 'all', persisted: false, applies_to: 'this_conversation', background_capture_unchanged: true });
    expect(res.body.rule_text).toContain('for the rest of this conversation');
    expect(res.body.rule_text).toContain('visibility: "private"');
    expect(await engine.executeRaw('SELECT key, value FROM config ORDER BY key')).toEqual(before);
  });

  test('off returns the explicit-only rule and is honest about host capture', async () => {
    await engine.setConfig('memory.agent_writeback', 'all');
    const res = await call('memory_conversation_mode', { mode: 'off' }, { scopes: ['write'] });
    expect(res.body.effective_mode).toBe('off');
    expect(res.body.rule_text).toContain('only what the user explicitly asks you to keep');
    expect(res.body.rule_text).toContain('background capture');
  });

  test('brain returns the brain\'s effective rule', async () => {
    await engine.setConfig('memory.agent_writeback', 'salient');
    const res = await call('memory_conversation_mode', { mode: 'brain' }, { scopes: ['write'] });
    expect(res.body.effective_mode).toBe('salient');
    expect(res.body.rule_text).toContain('enabled by this brain');
  });

  test('a read-only connection is refused; an invalid mode is never repaired into another mode', async () => {
    const ro = await call('memory_conversation_mode', { mode: 'all' }, { scopes: ['read'] });
    expect(ro.isError).toBe(true);
    const bound = await call('memory_conversation_mode', { mode: 'all' }, { auth: auth(['read', 'write'], { boundSlugPrefixes: ['people/alice-example'] } as Partial<AuthInfo>) });
    expect(bound.isError).toBe(true);
    const bad = await call('memory_conversation_mode', { mode: 'pause' }, { scopes: ['write'] });
    expect(bad.isError).toBe(true);
    expect(JSON.stringify(bad.body)).not.toContain('"tool":"memory_conversation_mode"');
  });
});

describe('initialize instructions', () => {
  test('the switch clause appears only when the tool is callable, after the governing rule', () => {
    const withIt = buildMcpInstructions({ tools: { callable: () => true } });
    const at = withIt.indexOf('memory_conversation_mode');
    expect(at).toBeGreaterThan(withIt.indexOf('The record whose terms are in effect'));
    expect(withIt).toContain('save everything from here, or to stop saving');
    const without = buildMcpInstructions({ tools: { callable: n => n !== 'memory_conversation_mode' } });
    expect(without).not.toContain('memory_conversation_mode');
  });

  test('an agent override turns the ambient section on even while the operator mode is unset', async () => {
    await engine.setConfig('memory.agent_writeback', 'all');
    const bundle = (await resolveAgentWriteback(engine, CONFIG)).bundle;
    const text = buildMcpInstructions({ writeback: ambientOptsFrom(bundle, { remember: true, extractFacts: true }) });
    expect(text).toContain('Ambient memory writeback (enabled by this brain');
    expect(captureLaneStates(await resolveWritebackConfig(engine, CONFIG, { gate: true })).writeback).toBe('retire');
  });
});
