/**
 * Regression coverage for misleading doctor warnings on PGLite brains and
 * gateway-loop subagent configuration.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { buildChecks } from '../src/commands/doctor.ts';

const OLD_ENV = { ...process.env };
let home: string;
let engine: PGLiteEngine;

async function setupEngine(extraConfig: Record<string, unknown> = {}) {
  home = mkdtempSync(join(tmpdir(), 'gbrain-doctor-regression-'));
  process.env = { ...OLD_ENV };
  delete process.env.ANTHROPIC_API_KEY;
  process.env.GBRAIN_HOME = home;
  process.env.GBRAIN_CHAT_MODEL = 'openai:gpt-5.2';
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(
    join(home, '.gbrain', 'config.json'),
    JSON.stringify({
      engine: 'pglite',
      database_path: join(home, '.gbrain', 'brain.pglite'),
      chat_model: 'openai:gpt-5.2',
      ...extraConfig,
    }, null, 2) + '\n',
  );
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
}

async function teardownEngine() {
  try { await engine?.disconnect(); } catch {}
  process.env = { ...OLD_ENV };
  if (home) rmSync(home, { recursive: true, force: true });
}

async function checkMap() {
  const checks = await buildChecks(engine, ['--json', '--scope=brain']);
  return new Map(checks.map((c) => [c.name, c]));
}

describe('doctor PGLite and gateway-loop warnings', () => {
  beforeEach(async () => {
    await setupEngine();
  });

  afterEach(async () => {
    await teardownEngine();
  });

  test('PGLite reports pgvector and jsonb integrity as ok/not-applicable, not warnings', async () => {
    const checks = await checkMap();
    expect(checks.get('pgvector')?.status).toBe('ok');
    expect(checks.get('pgvector')?.message).toContain('PGLite');
    expect(checks.get('jsonb_integrity')?.status).toBe('ok');
    expect(checks.get('jsonb_integrity')?.message).toContain('PGLite');
  });

  test('agent.use_gateway_loop=true suppresses non-Anthropic missing-Anthropic-key warning', async () => {
    await engine.setConfig('agent.use_gateway_loop', 'true');
    const checks = await checkMap();
    const check = checks.get('subagent_capability');
    expect(check?.status).toBe('ok');
    expect(check?.message).toContain('agent.use_gateway_loop=true');
    expect(check?.message).not.toContain('ANTHROPIC_API_KEY is not set');
  });
});
