import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readModelServices, saveModelServices, saveModelServicesLive } from '../src/main/models/model-services';
import { saveSetup, getSetupInfo } from '../src/main/config-manager';

let home: string;
let configPath: string;
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.PMBRAIN_HOME;
  home = mkdtempSync(join(tmpdir(), 'pmbrain-revision-'));
  process.env.PMBRAIN_HOME = home;
  const directory = join(home, '.pmbrain');
  mkdirSync(directory);
  configPath = join(directory, 'config.json');
  writeFileSync(configPath, JSON.stringify({ engine: 'pglite', database_path: join(directory, 'brain.pglite'), embedding_disabled: true, desktop: { setup_completed: true } }));
});
afterEach(() => {
  if (previous === undefined) delete process.env.PMBRAIN_HOME;
  else process.env.PMBRAIN_HOME = previous;
  rmSync(home, { recursive: true, force: true });
});

test('two loaded pages cannot overwrite each other and rejected writes leave bytes unchanged', () => {
  const first = readModelServices();
  const second = readModelServices();
  const saved = saveModelServices({ ...first, services: first.services.map(item => item.id === 'ollama' ? { ...item, name: '最新名称' } : item) });
  expect(saved.revision).not.toBe(first.revision);
  const bytes = readFileSync(configPath, 'utf8');
  expect(() => saveModelServices({ ...second, services: second.services.map(item => item.id === 'ollama' ? { ...item, name: '旧页面名称' } : item) })).toThrow('配置已变化');
  expect(readFileSync(configPath, 'utf8')).toBe(bytes);
  expect(() => saveModelServices({ ...saved, revision: '' })).toThrow('配置已变化');
});

test('a pending runtime reload does not permit a second stale save', async () => {
  const old = readModelServices();
  let finish!: () => void;
  const pending = saveModelServicesLive({ ...old, services: old.services.map(item => item.id === 'ollama' ? { ...item, enabled: true, baseUrl: 'http://localhost:12500/v1' } : item) }, () => new Promise<void>(resolve => { finish = resolve; }));
  const current = readModelServices();
  const bytes = readFileSync(configPath, 'utf8');
  await expect(saveModelServicesLive(old, async () => { throw new Error('must not reload'); })).rejects.toThrow('配置已变化');
  expect(readFileSync(configPath, 'utf8')).toBe(bytes);
  finish();
  expect((await pending).revision).toBe(current.revision);
});

test('model roles reject a stale catalog revision before configuration is written', () => {
  const old = getSetupInfo();
  const fresh = readModelServices();
  saveModelServices({ ...fresh, services: fresh.services.map(item => item.id === 'ollama' ? { ...item, name: '已更新' } : item) });
  const bytes = readFileSync(configPath, 'utf8');
  expect(() => saveSetup({ engine: 'pglite', expectedModelRevision: old.modelRevision, modelConfig: { chatModel: 'ollama:new' } })).toThrow('配置已变化');
  expect(readFileSync(configPath, 'utf8')).toBe(bytes);
});

test('unrelated preferences do not invalidate a model draft and survive its save', () => {
  const draft = readModelServices();
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.last_migrated_version = '1.4.15';
  config.desktop.theme = 'light';
  writeFileSync(configPath, JSON.stringify(config));
  expect(readModelServices().revision).toBe(draft.revision);
  saveModelServices({ ...draft, services: draft.services.map(item => item.id === 'ollama' ? { ...item, name: '新名称' } : item) });
  const stored = JSON.parse(readFileSync(configPath, 'utf8'));
  expect(stored.desktop.theme).toBe('light');
  expect(stored.last_migrated_version).toBe('1.4.15');
});

test('database identity and fallback routes invalidate old model drafts', () => {
  const draft = readModelServices();
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.database_path = join(home, 'other.pglite');
  writeFileSync(configPath, JSON.stringify(config));
  expect(() => saveModelServices(draft)).toThrow('配置已变化');
  const next = readModelServices();
  config.chat_fallback_chain = ['ollama:other'];
  writeFileSync(configPath, JSON.stringify(config));
  expect(() => saveModelServices(next)).toThrow('配置已变化');
  expect(readFileSync(configPath, 'utf8')).toBe(JSON.stringify(config));
});
