# PMBrain 开发指南

## 指令优先级

开始工作前先完整阅读根目录 `AGENTS.md`。本文件补充项目结构和常用验证方式；
发生冲突时以 `AGENTS.md` 和用户当前指令为准。

项目相关工作先查询 PMBrain，结合已有知识再分析。随后只搜索
`项目管理/变更台账.md` 和 `项目管理/Bug修复台账.md` 最近五次记录，确有需要
才向前追溯。不要读取上游 `TODOS.md`、`CHANGELOG.md`。

## 项目定位

PMBrain 是面向项目管理和个人知识工作的知识大脑，核心能力包括：

- 多 Source 原始资料与 Wiki 管理；
- 中文友好的关键词、向量、标题、关系和 Reranker 混合检索；
- Dream 周期整理、事实抽取、概念与项目关系构建；
- CLI、MCP、桌面端和 Admin Console；
- DeepSeek、MIMO、智谱、Ollama、OpenAI 兼容接口等普通模型配置。

上游 GBrain 是底层逻辑的重要基线。涉及检索、Dream、拉取或合并上游代码时，
先阅读 `docs/eval/PMBrain与原版GBrain的检索和Dream功能对比.md`，逐项判断
“沿用、PMBrain 新增、不适用”，不能整段覆盖 PMBrain 的国内模型、桌面端和
多 Source 语义。

## 不可破坏的数据边界

- 不删除或修改原始资料。
- 不覆盖 Wiki。
- 不批量修改知识库。
- 不自动清空、重建或混写已有向量。
- 模型切换只能在用户明确确认后重建派生向量；原始文档、页面和分块必须保留。
- Source 内实体优先；`default` 只作共享实体回退。跨 Source 只允许精确路径或显式限定链接，不自动合并同名实体。

底层架构是 CLI、GUI、桌面端共同调用的核心能力和数据逻辑。涉及这一层的设计
变更必须先得到用户确认；实现时采用最小兼容修改。

## 架构入口

- CLI 路由：`src/cli.ts`、`src/commands/`
- 共享能力：`src/core/`
- Operation/MCP 合约：`src/core/operations.ts`
- 桌面端：`desktop/`
- Admin Console：`admin/`
- Schema 与迁移：`src/schema.sql`、`src/core/schema-embedded.ts`、
  `src/core/pglite-schema.ts`、`src/core/migrate.ts`
- 项目技能：`skills/RESOLVER.md`

不要假设所有 CLI 和 MCP 能力都由 `operations.ts` 自动生成。先用 `rg` 追踪真实
调用链；共享能力优先复用 Operation，独立 CLI 命令仍可能有自己的 handler。

### 与 GBrain 同步的三层边界

- **UPSTREAM CORE**：`src/core/`、`src/cli.ts`、`src/commands/serve-http.ts` 中 OAuth、MCP
  与通用 HTTP 运行时骨架。少做结构重排，优先移植上游安全、正确性、RAG 和 Dream 修复。
- **PMBrain ADAPTER**：连接上游能力与产品交互的 PMBrain 增量。优先新增独立模块，
  让核心入口只保留注册或调用点，避免把上游主体搬散。
- **PRODUCT**：`desktop/`、`admin/`、Windows、中文和国产模型交互。可以按页面、
  manager、IPC 与安全职责拆分，但必须复用 Core / Operation / Admin API 的现有能力。

判断原则：保持上游骨架，向外抽 PMBrain 增量。PMBrain Admin 产品路由集中在
`src/commands/pmbrain-admin-routes.ts`，通用服务器仍由 `serve-http.ts` 负责；不要为了代码整洁
大拆 `src/cli.ts` 或检索、Dream、数据库核心文件。

## 按任务读取调用链

AI 不需要先理解整个项目，也不要默认通读 `docs/architecture/`。先读本文件了解项目
地图，再根据任务只追踪下面一条调用链；发现分支时用 `rg` 从真实符号继续向下找。

| 用户要改什么 | AI 首先读什么 |
|---|---|
| Admin 页面 | 先读 `admin/src/App.tsx`；再按任务读 `Knowledge.tsx`、`Import.tsx`、`Sources.tsx`、`BrainData.tsx`、`Dream.tsx`、`Settings.tsx`、`Connection.tsx` 或 `Documentation.tsx` → `admin/src/api.ts` → `src/commands/pmbrain-admin-routes.ts` 中对应 `/admin/api/*` 路由；知识搜索另看 `src/commands/admin-knowledge-search.ts`。`Console.tsx` 只是旧导入兼容出口 |
| Desktop | 先按职责读 `desktop/src/main/database/`、`sidecar/`、`network/`、`updates/`、`startup/`、`system/`、`integration/` 或 `app/`；IPC 注册读 `ipc-handlers.ts`，窗口信任边界读 `window-security.ts`，只有生命周期编排才读 `index.ts` → `desktop/src/preload/index.ts` → `desktop/src/renderer/` → `desktop/test/` 对应测试 |
| 搜索 / RAG | `src/core/search/` → `src/core/operations.ts` 或对应 Command → `evals/` 与 `test/` 定向用例 |
| 导入 | `src/core/import-file.ts` / `src/core/sync.ts` / `src/core/source-resolver.ts` → `src/commands/import.ts`；Admin 调用再读 `src/commands/pmbrain-admin-routes.ts` |
| Dream | `src/core/cycle/` 与 `src/core/cycle.ts` → `src/commands/dream.ts` → `src/commands/pmbrain-admin-routes.ts` 中 Admin 接口 |
| MCP | `src/core/operations.ts` → `src/mcp/dispatch.ts` → HTTP MCP 所在的 `src/commands/serve-http.ts` |
| 数据库 | `src/core/engine.ts` → `src/core/pglite-engine.ts` / `src/core/postgres-engine.ts` → `src/core/migrate.ts` 与 schema 文件 |
| 软件更新 | `desktop/src/main/updates/update-controller.ts` → `desktop/src/main/update-manager.ts` → `desktop/test/update-manager.test.ts` → `desktop/package.json` / `desktop/electron-builder.yml` 与发布配置 |
| Source | `src/core/source-resolver.ts` / `src/core/sources-load.ts` / `src/core/sources-ops.ts` → `src/commands/sources.ts`；Admin 调用再读 `src/commands/pmbrain-admin-routes.ts` |

只有任务涉及跨层契约或数据安全时，才补读对应的单篇架构文档：部署读
`docs/architecture/topologies.md`，Source 读 `brains-and-sources.md`，检索读
`RETRIEVAL.md`，数据保护读 `system-of-record.md`。

## 模型与 Embedding 契约

普通模型、任务层级模型、Dream 阶段模型和 Embedding 分开配置。

- 普通模型/API Key 不能自动选择向量模型。
- PMBrain 没有默认向量供应商。只有显式配置
  `embedding_model + embedding_dimensions` 后才允许向量化。
- 未配置时，导入和 Dream 保留原文与分块，搜索走关键词、标题和关系路径。
- Ollama、本地服务或云端 Embedding 失败时原样报错，不回退到
  ZeroEntropy 或其他模型。
- 非空向量必须记录实际 `provider:model`；空向量分块的 model 为 `NULL`。
- 维度相同但模型不同仍是不兼容的向量空间。
- 环境变量和 `config.json` 冲突时停止向量写入。

`DEFAULT_EMBEDDING_DIMENSIONS` 只是在尚未配置模型时创建数据库向量列的存储宽度，
不是默认模型，也不能启用向量化。

## RAG 与 Dream 验收

PMBrain 的固定质量入口是：

- `docs/eval/PMBrain检索与Dream质量评测规范.md`
- `docs/eval/PMBrain与原版GBrain的检索和Dream功能对比.md`

检索修改至少验证真实问题集、Recall@5、MRR、首条有效结果、引用准确率和
`vector_enabled`/Reranker 实际执行状态。一次检索未命中不能推断资料不存在；
先核对 Source，再用语义查询、精确关键词和原文页面交叉验证。

Dream 修改要区分原始资料、派生页和应参与连接率统计的知识页；验证孤儿页原因、
关系是否可解析、项目/人物/概念 Hub 是否真实入链，以及 Source 边界是否正确。

常用检索示例：

```powershell
pmbrain search "查询内容" --mode conservative
pmbrain search "查询内容" --mode balanced
pmbrain search "查询内容" --mode tokenmax
```

## 修改与测试

先写能复现问题的测试，再做最小实现，最后跑与风险匹配的验证。

依赖安装必须保持零数据库副作用：根包不得定义 `preinstall`、`install` 或 `postinstall`
生命周期钩子来初始化、打开或迁移数据库。新安装由用户显式运行 `pmbrain init`；已有
安装由用户显式运行 `pmbrain upgrade` 或 `pmbrain apply-migrations --yes`。

Windows 本机优先：

```powershell
bun test <定向测试文件>
bun run typecheck
```

CI 稳定性门禁的唯一入口是 `bun run verify`，其检查清单维护在
`scripts/run-verify-parallel.sh`；`bun run check:all` 仅保留为兼容别名，不得再维护第二条
检查链。完整链路为 `verify → test → test:slow → test:e2e`（有测试数据库时）→ `test:heavy`；
提交前本地预演是 `bun run ci:pr-preview`（verify + 检索/可见性散落契约，Windows 自动找 Git Bash）；
`ci:local:diff` 负责 Pull Request 的变更选择，`ci:local` 负责发布前本地链路。普通测试包装器
必须清掉 `DATABASE_URL`、`GBRAIN_DATABASE_URL`、`PMBRAIN_DATABASE_URL` 和显式 allow；只有
E2E wrapper 或明确的一次性命令可以设置 `GBRAIN_TEST_ALLOW_DATABASE_URL=1`，且仍须通过
测试数据库名 floor。生成的 `admin/dist`、`src/admin-embedded.ts`、`release-manifest.json`
必须在构建后保持零 diff，不能自动提交。

需要完整 Bash 门禁时使用 Git for Windows Bash；最终 GitHub CI 必须正常。本机因
Bash 环境缺失而未跑完的项目要明确报告为“部分验证”，不能当成业务通过。

桌面端修改还要在 `desktop/` 执行对应测试、类型检查和资源构建。不要运行
`bun run build:win`，Windows 安装包由用户最后执行。

修改 Admin Console 后才需要提供管理员登录链接；搜索、导入、Dream、CLI 或
桌面配置修改不需要提供。

## 版本与台账

用户明确要求的功能变更或 Bug 修复完成后：

1. 以 `desktop/package.json` 为产品唯一版本来源，递增后运行 `bun run version:sync`；
2. 根 `package.json`、`VERSION` 和发布清单仅同步同一个版本，不单独递增浏览器或 Core 版本；
3. 在对应子项目的中文 `变更台账.md` 或 `Bug修复台账.md` 倒序记录时间、版本、
   标题、描述、是否完成和最终结果；
4. 列出实现结果与原计划不一致的地方；
5. 保留用户已有工作区修改，不清理不相关文件。

纯文档整理、归档和文案更新在用户明确说明时，可以不写台账、不增加版本号。
