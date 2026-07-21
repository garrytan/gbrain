import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { buildCaptureCommand, buildDreamCommand, buildMarkdownExportCommand, commandForPreview, deriveSourceIdFromPath, MAX_NATURAL_TASK_CHARACTERS, previewIntent, resolveImportSourceIdForPath } from '../src/commands/admin-console.ts';
import { getAdminLlmStatus } from '../src/commands/natural-lang/llm.ts';
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

  test('custom OpenAI chat is ready with a chat endpoint and an optional touchpoint key', () => {
    const status = getAdminLlmStatus({
      chat_model: 'custom-openai:qwen-chat',
      provider_touchpoint_base_urls: {
        'custom-openai': { chat: 'http://127.0.0.1:8000/v1' },
      },
      provider_touchpoint_api_keys: {
        'custom-openai': { chat: 'chat-key' },
      },
    } as any);

    expect(status.enabled).toBe(true);
    expect(status.missing).toEqual([]);
  });

  test('Ollama chat is ready without an API key', () => {
    const status = getAdminLlmStatus({
      chat_model: 'ollama:qwen3.6:latest',
      expansion_model: 'ollama:qwen3.6:latest',
    } as any);

    expect(status.enabled).toBe(true);
    expect(status.provider).toBe('ollama');
    expect(status.missing).toEqual([]);
    expect(status.providersConfigured.ollama).toBe(true);
  });

  test('Ollama can pass the intent gate and use the shared gateway path', async () => {
    __setChatTransportForTests(async () => ({
      text: '',
      blocks: [{
        type: 'tool-call',
        toolCallId: 'ollama-call-1',
        toolName: 'pmbrain_action',
        input: { intent: 'search_brain', query: '本地模型搜索' },
      }],
      stopReason: 'tool_calls',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'ollama:qwen3.6:latest',
      providerId: 'ollama',
    }));

    const preview = await previewIntent('搜索本地模型内容', {
      chat_model: 'ollama:qwen3.6:latest',
      expansion_model: 'ollama:qwen3.6:latest',
    } as any);

    expect(preview.intent).toBe('search_brain');
    expect(preview.slots.query).toBe('本地模型搜索');
  });

  test('knowledge questions use the existing think synthesis command', () => {
    const command = commandForPreview({
      previewId: 'preview-search',
      intent: 'search_brain',
      confidence: 1,
      slots: { query: '项目文档' },
      proposedAction: '搜索知识库',
      riskLevel: 'read',
      requiresConfirmation: false,
    });
    expect(command.slice(-3)).toEqual(['think', '项目文档', '--json']);
  });

  test('direct text import reuses capture and respects the selected source', () => {
    const command = buildCaptureCommand('需要保存的完整正文', 'duwu');
    expect(command.slice(-4)).toEqual(['capture', '需要保存的完整正文', '--source', 'duwu']);
    expect(() => buildCaptureCommand('   ')).toThrow('Content is required');
  });

  test('Markdown export always creates a new PMBrain snapshot subdirectory', () => {
    const absoluteVault = process.platform === 'win32' ? 'D:\\Obsidian\\Vault' : '/tmp/Obsidian/Vault';
    const result = buildMarkdownExportCommand(
      absoluteVault,
      new Date('2026-07-11T03:04:05.000Z'),
      'abc123',
    );
    expect(result.outputDir.replace(/\\/g, '/')).toEndWith('/PMBrain-Export-20260711T030405-abc123');
    expect(result.command.slice(-3)).toEqual(['export', '--dir', result.outputDir]);
    expect(() => buildMarkdownExportCommand('relative/path')).toThrow('absolute path');
  });

  test('import path resolves registered source by local_path prefix', async () => {
    const sourceRoot = join(process.cwd(), 'fixtures', 'registered-source');
    const engine = {
      executeRaw: async () => [
        { id: 'default', name: 'default', local_path: null, last_commit: null, last_sync_at: null, config: {}, created_at: new Date() },
        { id: 'dingdan-qingdan', name: 'dingdan-qingdan', local_path: sourceRoot, last_commit: null, last_sync_at: null, config: {}, created_at: new Date() },
      ],
    } as any;

    const sourceId = await resolveImportSourceIdForPath(engine, join(sourceRoot, 'project-management.md'));

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

  test('meeting preset is forwarded to the canonical Dream CLI', () => {
    const command = buildDreamCommand({
      preset: 'meeting',
      input: 'D:\\meetings',
      dryRun: false,
    });
    expect(command.slice(3)).toEqual([
      'dream',
      '--preset',
      'meeting',
      '--input',
      'D:\\meetings',
    ]);
  });

  test('full preset enables bounded proposal draining without overriding the upstream 100-page batch', () => {
    const command = buildDreamCommand({
      preset: 'full',
      sourceId: 'duwu',
      drainProposals: true,
      windowSeconds: 3600,
    });
    expect(command.slice(3)).toEqual([
      'dream',
      '--preset',
      'full',
      '--source',
      'duwu',
      '--drain-proposals',
      '--window',
      '3600',
    ]);
    expect(command).not.toContain('--max-pages');
  });

  test('phase and preset cannot create two competing Dream selections', () => {
    expect(() => buildDreamCommand({ phase: 'lint', preset: 'quick' })).toThrow('mutually exclusive');
  });
});
