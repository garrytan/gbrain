import { expect, test, mock } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('模型设置只读取配置，知识库查询挂起时仍能打开，常规设置保留原有查询', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pmbrain-config-read-test-'));
  const keys = ['PMBRAIN_HOME', 'GBRAIN_HOME'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  let queries = 0;
  let release!: (value: unknown) => void;
  const database = new Promise(resolve => { release = resolve; });
  try {
    for (const key of keys) process.env[key] = root;
    mkdirSync(join(root, '.pmbrain'));
    writeFileSync(join(root, '.pmbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: join(root, 'database'), chat_model: 'ollama:test', desktop: { setup_completed: true, knowledge_directory: root, main_source_path_repair_completed: true } }));
    mock.module('electron', () => ({ app: {} }));
    const { SetupController } = await import('../desktop/src/main/startup/setup-controller.ts');
    const controller = new SetupController({ sidecar: { state: { phase: 'ready' }, current: { port: 12345, mcpUrl: 'http://127.0.0.1:12345/mcp', adminRequest: async () => { queries++; return database; } } } } as any);
    const state = await controller.currentState(true);
    expect(state.setup.needsSetup).toBe(false);
    expect(state.setup.current.chatModel).toBe('ollama:test');
    expect(queries).toBe(0);
    const regular = controller.currentState();
    await Bun.sleep(10);
    expect(queries).toBeGreaterThan(0);
    release({ main_source_id: 'default', sources: [] });
    await regular;
  } finally {
    release?.({});
    mock.restore();
    for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    rmSync(root, { recursive: true, force: true });
  }
});
