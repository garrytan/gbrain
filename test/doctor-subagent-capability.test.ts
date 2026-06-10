import { describe, test, expect, afterEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { checkSubagentCapability } from '../src/commands/doctor.ts';
import { withEnv } from './helpers/with-env.ts';

const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('doctor subagent_capability', () => {
  test('agent.use_gateway_loop=true suppresses non-Anthropic chat_model key warning', async () => {
    const home = join(tmpdir(), `doctor-subagent-capability-${process.pid}-${Date.now()}`);
    tmpRoots.push(home);
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(
      join(home, '.gbrain', 'config.json'),
      JSON.stringify({ engine: 'pglite', chat_model: 'openai:gpt-5.2' }),
      'utf8',
    );

    const engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    try {
      await engine.setConfig('agent.use_gateway_loop', 'true');
      await withEnv({
        GBRAIN_HOME: home,
        ANTHROPIC_API_KEY: undefined,
        GBRAIN_CHAT_MODEL: undefined,
        GBRAIN_DATABASE_URL: undefined,
        DATABASE_URL: undefined,
      }, async () => {
        const check = await checkSubagentCapability(engine);
        expect(check.status).toBe('ok');
        expect(check.message).toContain('agent.use_gateway_loop=true');
      });
    } finally {
      await engine.disconnect();
    }
  });
});
