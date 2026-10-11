# PMBrain 代码分层

PMBrain 不要求 AI 在每次任务前理解整个项目。先看项目地图，再沿当前任务的一条调用链读取。

## 分层

```text
Admin / Desktop / CLI / MCP
          ↓
Command 与 HTTP 路由
          ↓
Operation 与核心能力
          ↓
BrainEngine 接口
          ↓
PGLite / Postgres
```

### 交互层

- `admin/`：React Admin Console；请求封装在 `admin/src/api.ts`。
- `desktop/`：Electron 主进程、preload 和 renderer；主进程负责 Sidecar 生命周期。
- `src/cli.ts`、`src/commands/`：CLI 与部分独立命令处理器。
- `src/mcp/dispatch.ts`：MCP 调度。

### 合同与核心能力层

- `src/core/operations.ts`：共享 Operation 合同、权限和参数边界。
- `src/core/search/`：检索流水线。
- `src/core/import-file.ts`、`src/core/sync.ts`：导入和同步。
- `src/core/cycle/`：Dream 阶段。
- `src/core/source-resolver.ts`：Source 解析。

并非所有 CLI 命令都会自动经过 `operations.ts`。修改前必须用 `rg` 跟踪真实入口，不要根据
目录名猜测调用关系。

### 数据引擎层

- `src/core/engine.ts`：`BrainEngine` 接口；
- `src/core/pglite-engine.ts`：本地 PGLite；
- `src/core/postgres-engine.ts`：Postgres；
- `src/core/engine-factory.ts`：引擎选择；
- `src/core/migrate.ts`：迁移编排；
- `src/schema.sql`、`src/core/schema-embedded.ts`、`src/core/pglite-schema.ts`：schema。

### HTTP 服务的 PGLite 所有者与后台任务

`serve --http` 的 PGLite 由 `src/product/database/database-worker.ts` 中唯一实例管理。
服务线程通过 `WorkerPgliteEngine` 使用同一 `BrainEngine` 接口，不共享第二个实例，也不在
导入、模型等待或文件解析期间关闭数据库。CLI 原有直接引擎与 Postgres 接口保留。

根数据库请求按优先级排队，同级按到达顺序执行：用户即时操作 0、MCP 读取 1、导入提交 2、
后台整理及其状态持久化 3。当前事务的作用域调用属于该事务，事务自然提交或回滚之后才处理
下一根请求；高优先级不能打断正在执行的 SQL 或事务。非数据库阶段由两个任务 Worker 并行执行。

后台任务复用 `runStructuredImport`、`runQuickMaintenance`、`runCycle`，不包整阶段事务。
`TaskEngineHost` 对大批次调用划分提交单元，并保留每批的租约、模型、文件及页面版本检查：

| 操作 | 提交或读取边界 |
| --- | --- |
| 页面正文扫描 | 一次获取匹配 ID，再每 200 页读取正文；保持过滤、排序和 Source |
| 情绪输入 | 每 50 个页面引用，按 Source 读取 |
| 关系、时间线、观点、向量状态和批量页面操作 | 每 50 项 |
| 大批分块与向量写入 | 每 32 个分块；合并后单独清理过期 chunk 索引 |
| 后台向量待处理查询 | 每 100 项；CLI 默认参数不变 |
| 到期软删除页面 | 每 50 页，保持 TTL |
| 到期 Source | 每 1 个 Source，保持原级联原子性 |
| 到期操作检查点、志愿上下文事件 | 每 100 项，保持原 TTL |

模型、文件、OCR 等等待不持有业务事务。停止请求先发送取消信号，界面立即显示正在停止；
已进入的数据库调用自然结束，当前显式事务自然回滚或按原提交保护处理，关闭后的任务不得
启动下一批或提交迟到结果。活动任务进度来自服务内存，持久化合并进行，避免进度读取和停止
反馈再排在数据库重操作之后。界面关闭不停止后台任务。

边界：单文件页面、事实及分块清单的原子替换仍是一个事务；删除单个到期 Source 仍是一次
原子级联。这些单元可能随单文件或单 Source 体积增大，不能保证固定秒数内结束，也不能在其
执行中插入查询。此改造保证服务线程、模型配置和普通对话不被数据库计算占住，并让数据库
查询在事务边界优先执行；没有承诺正在执行的数据库操作能够被抢占。没有拆表或数据迁移。

桌面 Sidecar 显式包含数据库 Worker，继续携带外部 PGLite 运行资源。独立 Bun 编译版通过
`pglite-embedded-assets.ts` 嵌入 WASM、文件系统包及扩展资源；扩展包只物化到系统临时目录，
不改知识目录。编译版数据库启动和跨工作目录重载单独验收；历史 PDF 原生依赖问题不包含在
本次桌面数据库隔离验收的通过结论中。

## 修改原则

1. GUI 和 Desktop 优先调用已有 CLI、Operation 或 HTTP 能力。
2. 如果底层没有能力，先说明缺口，不要为了一个按钮偷偷新增另一套数据逻辑。
3. 核心能力或数据逻辑属于底层架构，修改前要得到用户确认。
4. 数据库相关改动同时验证 PGLite 和 Postgres。
5. 打包前检查实际内嵌 Admin、Sidecar 和资源，不以源码 diff 代替运行时验收。
