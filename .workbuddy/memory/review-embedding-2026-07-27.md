# 向量化模型链路 Code Review（2026-07-27）

范围：embedding/向量模型相关代码（`retrieval-upgrade-planner`、`config`、`gateway`/`defaults`、
`embedding-dimension-alignment`、`doctor`、`init`）。结论：已配置用户不会被自动重置，但链路里仍
有多处真实 bug，集中在「DB plane 与 file plane 不一致」「env 覆盖静默生效」两类。

## 🔴 BUG A（高）planRetrievalUpgrade 读取源与回退默认值都错了
- 位置：`src/core/retrieval-upgrade-planner.ts:247-250`
- 现状：
  - `currentEmbeddingModel = engine.getConfig('embedding_model') ?? 'openai:text-embedding-3-large'`
  - `currentDim = ... ?? 1536`
  - `engine.getConfig` 只查 DB 表 `config`（`pglite-engine.ts:4811`、`postgres-engine.ts:4901`），**不读 file plane**。
- 根因：规范上 `embedding_model` 的权威值写在 **file plane**（`init.ts` 只调 `saveConfig`，从不
  `engine.setConfig('embedding_model')`）；gateway 运行时经 `loadConfig()` 合并 file+db+env 才拿到真值。
  `planRetrievalUpgrade` 只读 DB plane → 新 ZE 脑/延后初始化脑的 DB 为空 → 回退到陈旧的
  `openai:text-embedding-3-large`/1536（真实默认见 `defaults.ts:20-21` 是 `zeroentropyai:zembed-1`/1280）。
- 后果：
  1. 误判 `isLegacyDefault=true`、误报 `current_dim=1536`（实际 1280）→ `pagesPendingDim=totalPages` 假阳性，成本估算错误；
  2. 已处于 ZE 默认的新脑在 `gbrain ze-switch` 预览里被反复「建议切换」（接受后写 DB 自愈，但首次预览是错的）。
- 修复：读取改用合并后的 `loadConfig()`（file+db+env），回退默认值改用
  `DEFAULT_EMBEDDING_MODEL` / `DEFAULT_EMBEDDING_DIMENSIONS`（ZE 1280），删除硬编码 openai 常量。

## 🔴 BUG B（高）switchEmbeddingModel 同值 unset 且不做对齐
- 位置：`src/commands/config.ts:52-58`
- 现状：`if (previousModel === nextModel) { unsetConfig('embedding_model'); unsetConfig('embedding_dimensions'); return; }`
  当新模型与当前相同，直接删配置、回退默认，且**不调用 alignEmbeddingDimension** 就 return。
- 后果：老用户若在 openai:1536 上重新执行 `gbrain config set embedding_model openai:text-embedding-3-large`
  （重装脚本/文档照搬常见），配置被删 → gateway 回退到 ZE 1280，而 schema 列仍是 1536 → 下次 embed 直接
  报「维度不匹配」失败（可见但突兀，需手动修复）。
- 修复：同值时不要 unset，直接提示「无变化」并 return；或保留显式配置不删。

## 🔴 BUG C（高，历史事故同源）普通 embed 路径 env 覆盖仍静默生效
- 位置：`src/core/config.ts:381-382`（loadConfig 注入 `PMBRAIN_EMBEDDING_MODEL`/`GBRAIN_EMBEDDING_MODEL` 等）
- 现状：`detectEnvOverride`（`retrieval-upgrade-planner.ts:167`）**只在 ze-switch 路径**拦截；但日常
  `gbrain embed` 经 `loadConfig()` 合并后仍会把环境变量当作最高优先级静默套用，无任何提示。
- 后果：这正是 716K 事故（PR #1421）原路径——只要 shell/.env 里残留 `GBRAIN_EMBEDDING_MODEL`，
  每次 embed 都用 env 指定的模型，与 DB/界面看到的不一致，维度不同则向量写错列或报错。
- 修复：在 embed/gateway 配置构建处对「env 与 config 不一致」做硬提示并要求确认（或干脆从生产 embed 路径剔除 env 覆盖，仅作开发期便利），而非仅在 ze-switch 一处拦截。

## 🟡 BUG D doctor 漏检 PMBRAIN_* 环境变量
- 位置：`src/commands/doctor.ts:2218-2219`
- 现状：只检查 `process.env.GBRAIN_EMBEDDING_MODEL` / `GBRAIN_EMBEDDING_DIMENSIONS`，未检查
  推荐的 `PMBRAIN_EMBEDDING_MODEL` / `PMBRAIN_EMBEDDING_DIMENSIONS`（loadConfig 的 envCompat 两者都接受）。
- 后果：用 `PMBRAIN_*` 覆盖时 doctor 报 ok，但运行时 gateway 实际生效 → 监控盲区。
- 修复：doctor 检查改用与 envCompat 一致的双变量名。

## 🟡 BUG E detectEnvOverride 只比对 target，不比对当前生效模型
- 位置：`src/core/retrieval-upgrade-planner.ts:167-189`
- 现状：env 模型只与 `targetModel`（ZE 目标）比较；若 env==target 则放行，但 env 仍可能与 DB 当前值不同。
- 后果：边界场景语义不精确（低危）。建议同时比对合并后的当前生效模型。

## 🟡 BUG F（待核实）alignDerivedEmbeddingStores 把 facts/query_cache 列重建到文本模型 targetDim
- 位置：`src/core/embedding-dimension-alignment.ts:82-146`
- 担忧：`runSchemaTransition` 注释（planner:556-567）明确 multimodal/image 列**不能**按文本 targetDim 重建。
  `facts`/`query_cache` 是否也跟随文本模型维度需确认；若它们独立定维，此处会静默破坏其向量。
- 行动：需核实 facts/query_cache 的实际维度来源后再定是否 bug。

## 🟢 观察（非 bug）
- `alignEmbeddingDimension` 第 194 行 `if (current.dims === targetDimensions)` 处于第 165 行分支的 else 内，
  属冗余死分支，逻辑可读性差，建议简化。
- `switchEmbeddingModel` 成功后 `unsetConfig` 清 DB、保留 file（file 为权威）——这是 BUG A 被放大的根因之一。

## 结论
老用户不会被「自动」重置（upgrade/启动/initSchema/doctor 均不改模型）。但上述 BUG A/B/C 会让
**环境变量残留**或**手动重设同值**时模型被悄悄改掉或报错，且 A 会让 ZE 新脑的切换预览/成本估算失真。
建议优先修 A 与 C（C 是历史事故同源路径，仍开着）。
