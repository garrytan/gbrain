# 2026-07-07 embedding 维度 UI 联动修复与打包记录

## 背景

用户之前从 ZeroEntropy（1280 维）切换到智谱 embedding-3（1024 维）时，config.json 中 embedding_dimensions 仍保持 1280，导致知识库导入时报错 "expected 1280 dimensions, not 1024"。上次修复（1.0.74）解决了 config 缺失维度时的兜底问题，但**已配置错误维度**的情况没有覆盖。

## 本次修改（方案 A：UI 联动）

### 修改文件

**`desktop/src/renderer/src.ts`**

1. 新增 `MODEL_DEFAULT_DIMENSIONS` 映射表（第 20-32 行）
   - 覆盖 7 个厂商 10 个常见 embedding 模型的默认维度
   - zhipu:embedding-3/embedding-2 → 1024
   - zeroentropyai:zembed-1 → 1280
   - mimo:text-embedding-3-small → 1536
   - openai:text-embedding-3-small → 1536
   - openai:text-embedding-3-large → 3072
   - deepseek:deepseek-embedding → 1536
   - google:text-embedding-004 → 768
   - voyage:voyage-3/voyage-3-lite → 1024/512

2. 新增 `updateEmbeddingDimensionsDefault()` 函数（第 34-43 行）
   - 用户切换 embedding 厂商或输入模型名时自动更新维度输入框
   - 不覆盖用户手动修改的权

3. 新增事件绑定（第 364-365 行）
   - `#embedding-provider` 的 `change` 事件
   - `#embedding-model-name` 的 `input` 事件

### 版本变更

- 项目 VERSION：1.0.75 → 1.0.76
- 桌面端 package.json：1.0.42 → 1.0.43
- 安装包：`PMBrain-Windows-x64-Setup-1.0.43.exe`

### 打包问题

第一次用 `build:win` 正确生成 1.0.42 安装包（包含代码修改），但后续用 `--config.extraMetadata.version=1.0.76` 额外跑了一次 electron-builder，导致 `latest.yml` 指向错误的版本号。已清理错误文件，递增桌面版版本到 1.0.43 后重新打包。

### 补充结论

桌面端继续保留 UI 自动联动：切换 embedding 厂商或模型名时，维度输入框会带出已知模型默认维度，减少从 ZeroEntropy 1280 切到智谱 1024 时沿用旧值的问题。

后端不再替用户猜测或修正维度：用户最终在输入框里填多少就保存多少；如果没有填写有效维度，保存配置直接报错。安装新版本后，若数据库已在旧版中按 `vector(1280)` 创建，而当前配置为 `1024`，Postgres 启动时只提示维度不匹配，不自动 ALTER 或清空旧向量。需要用户手动迁移数据库列，或重新初始化 Docker/Postgres 数据库。
