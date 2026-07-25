---
kind: configuration_system
name: GBrain 配置系统：文件/环境变量/数据库三平面分层与合并
category: configuration_system
scope:
    - '**'
source_files:
    - src/core/config.ts
    - src/core/storage-config.ts
    - src/core/archive-crawler-config.ts
    - gbrain.yml
---

## 系统概览

gbrain 采用「三平面 + 严格优先级」的配置模型，将运行时配置拆分为三个来源并按固定顺序合并：

1. **文件平面（File Plane）**：`~/.gbrain/config.json`（可通过 `GBRAIN_HOME` 覆盖），由 `loadConfig()` / `loadConfigFileOnly()` 同步读取。
2. **环境变量平面（Env Plane）**：以 `GBRAIN_*` 前缀为主的进程环境变量，在 `loadConfig()` 中覆盖文件平面。
3. **数据库平面（DB Plane）**：通过 `engine.getConfig(key)` 从脑库读取，仅在 `loadConfigWithEngine()` 中于已连接引擎后叠加到基础配置上。

此外，**仓库级 `gbrain.yml`** 作为“大脑仓库”的声明式清单，被独立的解析器（`storage-config.ts`、`archive-crawler-config.ts`）按子节加载，不参与 `GBrainConfig` 主树，而是通过 schema-pack 等子系统参与七层决策链。

## 关键文件与包

- `src/core/config.ts` — 核心配置加载、合并、持久化、键白名单；导出 `loadConfig`、`loadConfigWithEngine`、`saveConfig`、`configDir`、`configPath`、`toEngineConfig`、`getDbUrlSource`、`isThinClient`、`KNOWN_CONFIG_KEYS`、`KNOWN_CONFIG_KEY_PREFIXES`。
- `src/core/storage-config.ts` — 解析仓库根 `gbrain.yml` 的 `storage:` 段（`db_tracked` / `db_only`），含废弃键映射与一次警告。
- `src/core/archive-crawler-config.ts` — 解析 `gbrain.yml` 的 `archive-crawler:` 段，强制非空 allow-list 并拒绝路径穿越。
- `gbrain.yml`（仓库根示例）— 存储分层目录清单。
- `bunfig.toml` — 测试超时与预加载钩子（属于构建期配置，非运行时）。
- `src/cli.ts` — CLI 入口，统一调用 `loadConfig` / `loadConfigWithEngine` 驱动各子命令。

## 架构与约定

### 1. 配置项分类与写入面

| 类别 | 典型字段 | 写入方式 | 读取时机 |
|---|---|---|---|
| 启动敏感（影响 schema 尺寸/引擎选择） | `engine`、`database_url`、`database_path`、`embedding_model`、`embedding_dimensions`、`chat_model`、`expansion_model`、`provider_base_urls`、`remote_mcp.*`、`self_upgrade.*` | 仅文件+env（`loadConfig`） | 进程启动、引擎 connect 之前 |
| 运行时可热改（不改变 schema） | `embedding_multimodal*`、`embedding_image_ocr*`、`embedding_columns`、`search_embedding_column`、`content_sanity.*`、`dream.*`、`mcp.*`、`autopilot.*` | DB 平面（`gbrain config set`）+ 文件/env | 引擎连接后 `loadConfigWithEngine` 叠加 |
| 仓库清单（非 `GBrainConfig` 树） | `gbrain.yml` 的 `storage:`、`archive-crawler:` | 编辑仓库根 YAML | 按需解析，独立校验 |

### 2. 优先级规则

- **全局优先级**：`env > file > DB > 内置默认值`。
- **DB 平面是“缺省填充”**：只有当 env/file 未提供某 key 时，才回落到 DB；若 env 设置了该 key，则完全跳过 DB 读取。
- **DATABASE_URL 劫持防护**：`effectiveEnvDatabaseUrl()` 检测 Bun 自动从 cwd `.env` 加载的 `DATABASE_URL`，将其视为“项目变量”而非 gbrain 配置，除非显式设置 `GBRAIN_DATABASE_URL`。

### 3. 安全与健壮性

- `saveConfig` 写 `~/.gbrain/config.json` 时强制 `0600` 权限，并自动创建 `~/.gbrain/.gitignore`（内容 `*`）防止误提交。
- `GBRAIN_HOME` 必须为绝对路径且不含 `..`，否则抛错。
- `archive-crawler` 配置强制要求非空 `scan_paths`，拒绝相对路径与 `..` 片段，并对路径做规范化与尾斜杠补齐。
- 旧版 `provider` + `model` 形状会被 `migrateLegacyEmbeddingConfig` 迁移为 `embedding_model: "<provider>:<model>"` 并输出一次性 stderr 提示。

### 4. 键治理

- `KNOWN_CONFIG_KEYS` 维护所有受支持的扁平键名，`gbrain config set` 据此做拼写建议与白名单校验。
- `KNOWN_CONFIG_KEY_PREFIXES` 允许带通配符的子键（如 `models.*`、`dream.*`、`embedding_columns.*`），避免对动态结构逐一注册。

## 开发者应遵循的规则

1. **新增配置项时**：
   - 若影响 schema 或引擎选择 → 放入 `GBrainConfig` 接口并在 `loadConfig()` 中处理 env 覆盖。
   - 若仅运行时行为 → 在 `loadConfigWithEngine()` 中增加 DB 平面合并分支，并将键名加入 `KNOWN_CONFIG_KEYS`。
   - 如需 env 覆盖，遵循 `GBRAIN_<UPPER_SNAKE>` 命名约定，并在 `loadConfig()` 中显式映射。

2. **不要直接读写 `process.env`**：所有配置访问应通过 `loadConfig()` / `loadConfigWithEngine()` 返回的对象，确保优先级一致。

3. **仓库级 YAML 配置**：新增 `gbrain.yml` 子节时，参照 `storage-config.ts` 的“窄解析 + normalize + validate”模式，保持零依赖、可预测行为。

4. **敏感信息**：API Key 等凭据优先使用 env 注入（`OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`ZEROENTROPY_API_KEY`），避免落盘；必要时再落 `config.json` 并确保 `0600`。

5. **远程 MCP 薄客户端**：通过 `remote_mcp` 字段切换拓扑，CLI 会在连接引擎前检查并拒绝本地 DB 绑定子命令；`oauth_client_secret` 支持 `GBRAIN_REMOTE_CLIENT_SECRET` 覆盖。