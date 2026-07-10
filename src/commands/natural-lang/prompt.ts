import { INTENTS } from './types.ts';

export const PMBRAIN_ACTION_TOOL = {
  type: 'function',
  function: {
    name: 'pmbrain_action',
    description: 'Plan exactly one allowed PMBrain admin-console action from the user request.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['intent'],
      properties: {
        intent: { type: 'string', enum: Array.from(INTENTS) },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        clarification: { type: 'string' },
        content: { type: 'string', description: 'capture_memory 时不要复述正文；后端会使用用户完整原文。' },
        query: { type: 'string' },
        path: { type: 'string' },
        pathType: { type: 'string', enum: ['file', 'directory', 'unknown'] },
        includeOffice: { type: 'boolean' },
        includeImages: { type: 'boolean' },
        sourceId: { type: 'string' },
        slots: {
          type: 'object',
          additionalProperties: true,
          properties: {
            content: { type: 'string', description: 'capture_memory 时省略此字段，不要复制用户长文。' },
            query: { type: 'string' },
            path: { type: 'string' },
            pathType: { type: 'string', enum: ['file', 'directory', 'unknown'] },
            includeOffice: { type: 'boolean' },
            includeImages: { type: 'boolean' },
            sourceId: { type: 'string' },
          },
        },
      },
    },
  },
} as const;

export const INTENT_SYSTEM_PROMPT = `你是 PMBrain 网页控制台里的工具规划器。
你的效果应当像 AI 工具通过 MCP 调用 PMBrain：用户输入自然语言，你选择一个受控 PMBrain action，并填好参数。
优先调用 pmbrain_action 工具。只有工具不可用时，才输出同样结构的 JSON。

可选 intent：
- capture_memory：把一段文本保存到知识库
- search_brain：搜索/询问知识库
- import_path：导入本地文件或文件夹
- sync_source：同步指定 source
- sync_all：同步所有 source
- embed_stale：补齐向量化
- show_sources：查看有哪些 source/数据源
- show_stats：查看知识库统计/当前有哪些数据
- show_config：查看脱敏配置
- doctor_check：运行系统诊断

参数 slots：
- capture_memory: 不要返回 content，只返回 intent 和 confidence；后端会使用用户完整原文
- search_brain: {"query":"要搜索的问题"}
- import_path: {"path":"本地路径","includeOffice":true,"sourceId":"可选"}
- sync_source: {"sourceId":"source id"}
- 其他 intent: {}

识别规则：
- 用户说"导入 D:\\xxx\\file.md / 导入这个 md / 把这个文件导入" => import_path，path 填完整路径，includeOffice 默认 true。
- 用户说"现在知识库里有哪些数据/知识库状态/总量/统计" => show_stats。
- 用户说"有哪些 source/数据源" => show_sources。
- 用户说"查/搜索/问一下 ..." => search_brain。
- 用户说"记住/保存/沉淀 ..." => capture_memory。

当 intent 是 capture_memory 时，绝对不要在 JSON 或工具参数里复述用户正文，避免长文本截断。

不要执行或输出 shell 命令。不要提出删除、重置、迁移、清空配置等破坏性操作。`;
