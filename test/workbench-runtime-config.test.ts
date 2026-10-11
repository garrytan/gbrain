import { expect, test } from 'bun:test';
import express from 'express';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerWorkbenchRoutes } from '../src/product/workbench/routes';
import { rememberedChatModel } from '../admin/src/workbench/chat-model';

test('remembered model must still exist; an empty list clears the selection', () => {
  expect(rememberedChatModel('removed', 'current', ['current', 'other'])).toBe('current');
  expect(rememberedChatModel('current', 'other', ['current', 'other'])).toBe('current');
  expect(rememberedChatModel('removed', 'removed', [])).toBe('');
});

test('running workbench reads model additions, renames and removals without restart', async () => {
  let live: any = { engine: 'pglite', chat_model: 'ollama:first' };
  const app = express();
  registerWorkbenchRoutes(app, (_req, _res, next) => next(), {} as any, live, {
    storageRoot: mkdtempSync(join(tmpdir(), 'pmbrain-model-refresh-')),
    readConfig: () => live,
    answer: async input => ({ text: 'ok', model: input.model, citations: [] }),
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}/admin/api/workbench`;
  try {
    expect((await (await fetch(base + '/models')).json() as any).models[0].id).toBe('ollama:first');
    live = { engine: 'pglite', chat_model: 'ollama:second', desktop: { model_services: [{ id: 'ollama', provider: 'ollama', name: '本地', enabled: true, models: [{ id: 'second', name: '新名称', kind: 'chat', capabilities: [], contextWindow: 8192 }] }] } };
    const models = (await (await fetch(base + '/models')).json() as any).models;
    expect(models).toEqual([{ id: 'ollama:second', name: '新名称 · 本地', contextWindow: 8192 }]);
    const created = await (await fetch(base + '/conversations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'ollama:first' }) })).json() as any;
    const rejected = await fetch(`${base}/conversations/${created.id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '问题', model: 'ollama:first' }) });
    expect(rejected.status).toBe(400);
    const accepted = await fetch(`${base}/conversations/${created.id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '问题', model: 'ollama:second' }) });
    expect(accepted.status).toBe(200);
  } finally { server.close(); }
});
