# PMBrain - Claude Code 工作手册

> 给 Claude Code / Codex 使用的项目规则文档，非人读文档。
> 聚焦：不要怎么改 → 为什么要这样 → 去哪找东西

---

## 项目目标

个人知识大脑 + GStack 模块，为代理平台提供知识管理能力。
支持双引擎：PGLite（默认，零配置）和 Postgres + pgvector（1000+ 文件推荐）。

---

## 核心概念（必须理解）

### Brain / Source 双轴模型

**Brain** = 哪个数据库（个人 brain 是 `host`，可 `pmbrain mounts add` 挂载额外 brain）
**Source** = 数据库内的哪个仓库（wiki, gstack, openclaw, essays...）

路由解析（6 层）：`--brain` / `PMBRAIN_BRAIN_ID` / `.pmbrain-mount` dotfile（兼容 `.gbrain-mount`）
路由解析（6 层）：`--source` / `PMBRAIN_SOURCE` / `.pmbrain-source` dotfile（兼容 `.gbrain-source`）

### Trust Boundary

`OperationContext.remote` 区分：
- `remote: false` → 受信任本地 CLI 调用者
- `remote: true` → 不受信任代理面向调用者

安全敏感操作在 `remote=true` 时加强限制。

---

## 修改前检查（必须先读）

修改任何代码前，必须完成以下步骤：

1. **搜索是否已有类似实现**（grep / search）
2. **优先复用已有 Operation**（在 `src/core/operations.ts` 中查找）
3. **不新增平行架构**（禁止重新实现已有功能）
4. **保持 CLI 与 MCP 一致**（合约优先，改 operations.ts 即可）
5. **保持 Brain / Source 模型兼容**（向后兼容，不破坏现有数据）

**最常见错误：** 发现现有功能 → 懒得看 → 重新实现一套
**后果：** 代码重复、行为不一致、维护成本翻倍

---

## 开发规则

1. **优先复用已有 Operation**，不新增平行架构
2. **CLI 和 MCP 必须保持一致**（合约优先，改 `operations.ts` 即可）
3. **兼容已有 Brain 和 Source 模型**（向后兼容，不破坏现有数据）
4. **测试命令自己看 `package.json`**（`bun run test`, `bun run verify` 等）
5. **版本管理自己看 `VERSION` 文件和 git log**
6. **Skills 详细列表看 `skills/RESOLVER.md`**

---

## 设计原则（How & Why）

1. **合约优先（Contract First）**
   所有操作在 `src/core/operations.ts` 定义一次，CLI 和 MCP 从中生成。禁止平行架构。

2. **信任边界（Trust Boundary）**
   `OperationContext.remote` 控制能力边界。远程调用者不能执行危险操作。

3. **向前引导（Forward Bootstrap）**
   `applyForwardReferenceBootstrap()` 在重放 SCHEMA_SQL 前探测并添加缺失列/表，关闭升级楔子 bug。

4. **搜索模式（Search Mode）**
   三种命名模式（conservative / balanced / tokenmax）封装搜索旋钮。解析链：per-call → per-key config → MODE_BUNDLES → balanced fallback。

5. **评估纪律（Eval Discipline）**
   所有指标通过 `src/core/eval/metric-glossary.ts` 解析。

6. **新增功能优先复用已有 Operation**
   禁止新增平行架构，优先保持 CLI 与 MCP 一致，兼容已有 Brain 和 Source 模型。

---

## 关键文件（20% 密度）

### 核心引擎（必须改前先看）
- `src/core/operations.ts` — 合约定义（~47 操作）
- `src/core/engine.ts` — 可插拔引擎接口（BrainEngine）
- `src/core/engine-factory.ts` — 引擎工厂，动态导入
- `src/core/pglite-engine.ts` — PGLite 实现
- `src/core/postgres-engine.ts` — Postgres + pgvector 实现

### 搜索系统
- `src/core/search/hybrid.ts` — 混合搜索（vector + keyword + RRF + multi-query）
- `src/core/search/intent.ts` — 查询意图分类器
- `src/core/search/expansion.ts` — 多查询扩展（Haiku）

### 导入和同步
- `src/core/import-file.ts` — importFromFile + importFromContent
- `src/core/sync.ts` — 纯同步函数
- `src/core/chunkers/` — 3 层分块（recursive, semantic, LLM-guided）

### 评估和基准
- 存在完整评估体系，见 `src/commands/eval*`
- BrainBench 基准测试套件位于独立仓库 `gbrain-evals`

### Skills 系统
- `skills/RESOLVER.md` 是 Skills 入口

---

## 常用命令

```bash
pmbrain init                              # 初始化（默认 PGLite）
pmbrain migrate --to supabase            # 迁移到 Supabase
pmbrain search "query"                   # 基本搜索
pmbrain search --mode conservative       # 保守模式
pmbrain search --mode balanced           # 平衡模式（默认）
pmbrain search --mode tokenmax          # Token 最大化
pmbrain sync                             # 同步 brain repo
pmbrain import <file>                   # 导入单个文件
pmbrain jobs work                        # 启动后台任务进程
```

**详细命令参数：** 运行 `pmbrain --help` 查看

---

## 压缩说明

**目标读者：** Claude Code / Codex（非人读）
**文档定位：** 工作手册（不要怎么改 → 为什么要这样 → 去哪找东西）
**当前版本：** ~130 行（从原版 ~2000 行压缩 93.5%）

**保留内容（90% 有效信息）：**
- 项目目标（What）
- 核心概念（Brain / Source / Trust Boundary）
- 修改前检查（5 条约束，防止重复实现）
- 开发规则（6 条编码约束）
- 设计原则（6 条 How & Why）
- 关键文件（核心引擎 + 搜索 + 同步 + 评估 + Skills）
- 常用命令（9 条）

**删除内容：**
- 测试策略详细表格（Agent 自己看 package.json）
- 版本管理详细表格（Agent 自己 git grep）
- 成本表详细计算（产品文档，不是开发规则）
- 测试文件分类（*.test.ts 等）
- Skills 详细列表（29 个 → 1 句话指向 RESOLVER.md）
- 评估系统详细列表（5 条 → 1 句话指向 src/commands/eval*）
- 搜索模式成本锚点（已删除）

**增加内容：**
- 修改前检查（5 条，防止 Claude 重新实现已有功能）
- 开发规则提前（Claude 最先应该读到不要怎么改）

---


