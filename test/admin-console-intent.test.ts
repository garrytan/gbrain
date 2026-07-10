import { afterEach, describe, expect, test } from 'bun:test';
import { buildDreamCommand, deriveSourceIdFromPath, MAX_NATURAL_TASK_CHARACTERS, previewIntent, resolveImportSourceIdForPath } from '../src/commands/admin-console.ts';
import { __setChatTransportForTests, resetGateway } from '../src/core/ai/gateway.ts';

describe('admin console intent planning', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    __setChatTransportForTests(null);
    resetGateway();
  });

  test('MIMO tool call arguments are accepted when message content is empty', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{
        message: {
          content: '',
          tool_calls: [{
            type: 'function',
            function: {
              name: 'pmbrain_action',
              arguments: JSON.stringify({
                intent: 'import_path',
                path: 'D:\\Obsidian\\Vault\\raw\\a.md',
                includeOffice: true,
              }),
            },
          }],
        },
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

    const preview = await previewIntent('导入这个md', {
      chat_model: 'mimo:mimo-v2.5-pro',
      mimo_api_key: 'test-key',
    } as any);

    expect(preview.intent).toBe('import_path');
    expect(preview.slots.path).toBe('D:\\Obsidian\\Vault\\raw\\a.md');
    expect(preview.slots.pathType).toBe('file');
  });

  test('truncated capture JSON keeps the complete original text', async () => {
    let modelInput = '';
    globalThis.fetch = (async (
      _input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as any;
      modelInput = body.messages?.[1]?.content ?? '';
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: '```json\n{"intent":"capture_memo","content":"模型输出在长正文中被截断',
          },
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;

    const article = `标题\n${'完整正文。'.repeat(900)}`;
    const preview = await previewIntent(`${article}\n存入知识库`, {
      chat_model: 'mimo:mimo-v2.5-pro',
      mimo_api_key: 'test-key',
    } as any);

    expect(preview.intent).toBe('capture_memory');
    expect(preview.slots.content).toBe(article);
    expect(preview.proposedAction).toContain(`共 ${article.length.toLocaleString('zh-CN')} 字`);
    expect(modelInput.length).toBeLessThan(article.length);
    expect(modelInput).toContain('执行时仍使用完整原文');
    expect(modelInput).toContain('存入知识库');
  });

  test('natural-language input over the documented limit is rejected before calling the model', async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response('{}');
    }) as unknown as typeof fetch;

    await expect(previewIntent('字'.repeat(MAX_NATURAL_TASK_CHARACTERS + 1), {
      chat_model: 'mimo:mimo-v2.5-pro',
      mimo_api_key: 'test-key',
    } as any)).rejects.toThrow('不能超过 10,000 字');
    expect(called).toBe(false);
  });

  test('gateway tool-call blocks are accepted when result text is empty', async () => {
    __setChatTransportForTests(async () => ({
      text: '',
      blocks: [{
        type: 'tool-call',
        toolCallId: 'call-1',
        toolName: 'pmbrain_action',
        input: { intent: 'search_brain', query: '项目文档' },
      }],
      stopReason: 'tool_calls',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'zhipu:glm-4.5',
      providerId: 'zhipu',
    }));

    const preview = await previewIntent('查一下项目文档', {
      chat_model: 'zhipu:glm-4.5',
      zhipu_api_key: 'test-key',
    } as any);

    expect(preview.intent).toBe('search_brain');
    expect(preview.slots.query).toBe('项目文档');
  });

  test('import path resolves registered source by local_path prefix', async () => {
    const engine = {
      executeRaw: async () => [
        { id: 'default', name: 'default', local_path: null, last_commit: null, last_sync_at: null, config: {}, created_at: new Date() },
        { id: 'dingdan-qingdan', name: 'dingdan-qingdan', local_path: 'D:\\duwu\\youdao\\订单+清单项目', last_commit: null, last_sync_at: null, config: {}, created_at: new Date() },
      ],
    } as any;

    const sourceId = await resolveImportSourceIdForPath(engine, 'D:\\duwu\\youdao\\订单+清单项目\\项目管理.md');

    expect(sourceId).toBe('dingdan-qingdan');
  });

  test('import source resolver preserves explicit source id', async () => {
    const engine = {
      executeRaw: async () => [
        { id: 'matched-source', name: 'matched-source', local_path: 'D:\\duwu', last_commit: null, last_sync_at: null, config: {}, created_at: new Date() },
      ],
    } as any;

    const sourceId = await resolveImportSourceIdForPath(engine, 'D:\\duwu\\youdao\\x.md', 'manual-source');

    expect(sourceId).toBe('manual-source');
  });

  test('import source resolver falls back to main source when no source local_path matches', async () => {
    const engine = {
      executeRaw: async (sql: string) => {
        if (sql.includes('SELECT id FROM sources WHERE id = $1')) return [];
        return [
          { id: 'other-source', name: 'other-source', local_path: 'D:\\other', last_commit: null, last_sync_at: null, config: {}, created_at: new Date() },
        ];
      },
    } as any;

    const sourceId = await resolveImportSourceIdForPath(engine, 'D:\\duwu\\youdao\\x.md');

    expect(sourceId).toBe('default');
  });

  test('source id derivation uses readable ascii folder names', () => {
    expect(deriveSourceIdFromPath('D:\\duwu\\youdao\\Project Docs')).toBe('project-docs');
  });

  test('source id derivation falls back to stable hash for non-ascii folder names', () => {
    const first = deriveSourceIdFromPath('D:\\duwu\\youdao\\重庆保供项目');
    const second = deriveSourceIdFromPath('D:/duwu/youdao/重庆保供项目');

    expect(first).toMatch(/^source-[a-f0-9]{8}$/);
    expect(second).toMatch(/^source-[a-f0-9]{8}$/);
  });

  test('dream run command forwards source and max-pages', () => {
    const command = buildDreamCommand({
      phase: 'propose_takes',
      sourceId: 'pmgbrain',
      maxPages: 25,
      dryRun: true,
    });
    expect(command[0]).toBe('bun');
    expect(command[1]).toBe('run');
    expect(command[2].replace(/\\/g, '/')).toContain('src/cli.ts');
    expect(command.slice(3)).toEqual([
      'dream',
      '--phase',
      'propose_takes',
      '--source',
      'pmgbrain',
      '--max-pages',
      '25',
      '--dry-run',
    ]);
  });
});
