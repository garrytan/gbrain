# PMBrain — 项目管理知识大脑

PMBrain 是一个支持混合 RAG 搜索的项目管理知识大脑。把你的项目文档、会议纪要、需求文档、合同文件放进来，AI 就能自动构建知识图谱、追踪进度、预警风险、生成报告。

基于 [GBrain](https://github.com/garrytan/gbrain) 深度改造，保留完整知识管理能力，针对国内使用习惯做了大量优化。

---

## 核心能力

你的 AI 工具（CodeBuddy、Workbuddy、Codex、Cursor、Claude Code 等）原本每次对话独立，聊完就忘。PMBrain 给它们装上**有记忆的大脑**——AI 可以搜索你存过的所有文档、笔记、对话记录，回答问题时带着历史上下文。

- **混合搜索引擎**：向量搜索 + 关键词 + RRF 多重融合，搜索质量远高于单纯关键词匹配
- **知识图谱**：自动从文档中提取人物、公司、项目之间的关联关系
- **MCP 接口**：CodeBuddy、Workbuddy、Codex、Cursor、Claude Code、QwenPaw 等 AI 工具在对话中直接调用知识库
- **GUI 管理控制台**：浏览器导入资料、浏览知识库、审批观点、自然语言任务、MCP 接入配置、任务监控和系统诊断
- **数据本地化**：知识库数据库和原始资料默认保存在本机；使用云端模型时，向量化、聊天、识别所需内容会发送给你配置的模型提供商，使用本地模型可实现完整本地处理
- **双引擎架构**：PGLite（零配置本地）和 Postgres + pgvector（大规模生产）两种部署方式

---

## 快速开始

### Docker + Postgres（推荐）

```powershell
# 1. 启动 Postgres（含 pgvector）
docker run -d `
  --name pmbrain-postgres `
  -e POSTGRES_USER=postgres `
  -e POSTGRES_PASSWORD=postgres `
  -e POSTGRES_DB=pmbrain `
  -p 5433:5432 `
  -v pmbrain-postgres-data:/var/lib/postgresql/data `
  pgvector/pgvector:pg16

# 2. 确认 pgvector 可用
docker exec -it pmbrain-postgres psql -U postgres -d pmbrain -c "CREATE EXTENSION IF NOT EXISTS vector;"

# 3. 安装
bun install -g github:zhengyunhui123-dev/PMBrain

# 4. 配置 ~/.pmbrain/config.json
# { "engine": "postgres", "database_url": "postgresql://postgres:postgres@127.0.0.1:5433/pmbrain", ... }

# 5. 初始化和启动
pmbrain init
pmbrain serve --http --port 3131
```

浏览器打开 `http://localhost:3131/admin` 进入管理控制台。

### PGLite 本地模式（macOS / Linux 推荐）

```powershell
bun install -g github:zhengyunhui123-dev/PMBrain
pmbrain init --pglite
pmbrain serve --http --port 3131
```

> Windows 上 PGLite WASM 可能存在兼容性问题，推荐优先使用 Docker。详见 [安装文档](docs/INSTALL.md)。

### Windows 桌面版

一键安装，内置 Bun 运行时、PGLite 和 WASM 资源，兼容不支持 AVX2 的旧 x64 CPU。自动检测已有配置并沿用。详见 [桌面版安装指南](docs/desktop/安装与首次使用.md)。

更多安装方式（Supabase、源码安装、AI 自动安装）见 [完整安装文档](docs/INSTALL.md) 和 [AI 安装协议](INSTALL_FOR_AGENTS.md)。

---

## 特色功能

### 导入即用，无需转换格式

支持常用办公文档格式直接导入，不产生中间文件：

| 格式 | 说明 |
|------|------|
| `.md` / `.mdx` | Markdown 笔记 |
| `.docx` / `.doc` / `.wps` | Word 文档 |
| `.pdf` | PDF 文档 |
| `.xlsx` / `.xlsm` / `.xls` | Excel 表格 |
| `.csv` | 表格数据 |
| `.png` / `.jpg` / `.jpeg` / `.gif` / `.webp` / `.heic` / `.heif` / `.avif` | 图片和扫描件 |

```powershell
pmbrain sources add my-project --path "D:\项目文档"
pmbrain sync --source my-project
```

### 多模型支持（国内可用）

内置 20 类 AI 提供商（含自定义 OpenAI 兼容接口），国内可直接使用：

| 提供商 | 用途 |
|--------|------|
| 智谱 BigModel | 向量嵌入、对话 |
| MIMO 小米 | 搜索扩展、对话 |
| DeepSeek | 对话、搜索扩展 |
| OpenAI / Anthropic / Ollama | 嵌入 / 对话 / 重排序 |
| 自定义 OpenAI 兼容接口 | 本地 Qwen、vLLM、LM Studio、Xinference、LocalAI |

详细配置见 [AI 提供商配置速查](#ai-提供商配置速查)。

### 全量中文化

管理后台、CLI 帮助、仪表盘、文档页均已翻译为中文。命令行参数名和 JSON 字段等技术标识保持英文。

### Dream 周期与观点审批

Dream 周期分多个阶段运行（同步、抽取、概念整理、候选观点、观点打分、校准画像、嵌入刷新等）。候选观点先在 Admin Console 审批，确认后才进入正式知识库。

```powershell
pmbrain dream --phase propose_takes --dry-run --json --max-pages 25  # 安全预览
pmbrain dream --help                                                    # 查看所有阶段
```

### 自然语言 AI 控制台

Admin Console 支持自然语言操作：导入文件、同步知识库、搜索资料、运行诊断——系统自动识别意图并执行。

---

## 常用命令

```powershell
pmbrain init                              # 初始化（默认 PGLite）
pmbrain search "关键词"                    # 搜索知识库
pmbrain search "关键词" --explain          # 可溯源搜索（查看评分来源）
pmbrain search --mode conservative        # 保守模式（精确优先）
pmbrain search --mode tokenmax           # Token 最大化（召回优先）
pmbrain capture "要记住的内容"             # 保存当前对话/笔记
pmbrain sync --all                        # 同步所有知识库
pmbrain embed --stale                     # 重算过期向量
pmbrain import <文件或文件夹>              # 导入文件
pmbrain serve --http --port 3131          # 启动管理控制台
pmbrain doctor                            # 系统诊断
pmbrain migrate --to supabase            # 迁移到 Supabase
pmbrain --help                            # 查看所有命令
```

---

## MCP 接入 AI 工具

### HTTP + Bearer Token（推荐）

```json
{
  "mcpServers": {
    "pmbrain": {
      "type": "http",
      "url": "http://127.0.0.1:3131/mcp",
      "headers": {
        "Authorization": "Bearer <从Admin Console获取的API Key>"
      }
    }
  }
}
```

### 本地 STDIO 模式

```json
{
  "mcpServers": {
    "pmbrain": {
      "command": "pmbrain",
      "args": ["serve"]
    }
  }
}
```

支持 Claude Code、Claude Cowork、ChatGPT（Secure MCP Tunnel）、Perplexity、CodeBuddy、Workbuddy、Cursor、Codex、QwenPaw 等工具。详见 [MCP 部署指南](docs/mcp/) 和各工具接入文档。

---

## AI 提供商配置速查

| 功能 | 推荐提供商 | 模型标识 | 配置字段 |
|------|-----------|---------|---------|
| 向量化（必需） | 智谱 BigModel | `zhipu:embedding-3`（1024d） | `zhipu_api_key` |
| 对话/搜索扩展 | MIMO 小米 | `mimo:mimo-v2.5-pro` | `mimo_api_key` |
| Dream 提炼/判定 | MIMO 小米 | `mimo:mimo-v2.5-pro` | `mimo_api_key` |
| 对话备用 | DeepSeek | `deepseek:deepseek-v4-flash` | `deepseek_api_key` |
| 对话/嵌入（海外） | OpenAI | `openai:text-embedding-3-small`（1536d） | `openai_api_key` |

> 向量化是搜索的基础，建议优先申请智谱 Key（[open.bigmodel.cn](https://open.bigmodel.cn)）。智谱 `embedding-3` 每百万 token 仅 0.01 美元，国内可直接访问。

```json
{
  "zhipu_api_key": "你的智谱Key",
  "mimo_api_key": "你的MIMO Key",
  "deepseek_api_key": "你的DeepSeek Key"
}
```

切换向量模型请使用桌面端或 `pmbrain config set embedding_model <provider:model>`：PMBrain 先验证新模型连接和实际维度，验证通过后仅标记旧向量为待重算并立即使用新模型；原始页面和分块不会删除。

---

## 项目结构

```
PMBrain/
├── admin/                  # Admin Console 前端（React + Vite）
├── desktop/                # Electron Windows 桌面端
├── src/                    # 源代码
│   ├── cli.ts              # CLI 入口
│   ├── core/               # 核心引擎、搜索、AI 网关、Dream 周期
│   │   ├── engine.ts       # BrainEngine 接口
│   │   ├── operations.ts   # 所有操作定义
│   │   ├── search/         # 混合搜索（向量 + 关键词 + RRF + 多查询）
│   │   ├── ai/             # AI 网关 + 20 个提供商配方
│   │   ├── cycle/          # Dream 周期各阶段
│   │   └── facts/          # 事实队列系统
│   ├── commands/           # CLI 命令和 HTTP Admin Console 后端
│   └── mcp/                # MCP 服务器
├── skills/                 # AI 智能体技能
├── templates/              # 模式包模板
├── docs/                   # 完整文档（100+ 文件）
├── evals/                  # 评估基准
├── test/                   # 测试套件
├── CLAUDE.md               # AI Agent 工作手册
└── AGENTS.md               # AI 开发规则
```

---

## 文档索引

- **[安装文档](docs/INSTALL.md)** — Docker、PGLite、Supabase 三种部署方式
- **[桌面版安装指南](docs/desktop/安装与首次使用.md)** — Windows 桌面端首次配置
- **[Docker Postgres 首次安装](docs/desktop/首次安装使用DockerPostgres.md)** — PGLite/WASM 异常时的替代方案
- **[MCP 部署指南](docs/mcp/)** — OAuth 认证、远程部署、各工具接入
- **[ChatGPT 接入指南](docs/mcp/CHATGPT.md)** — Secure MCP Tunnel 方式
- **[架构文档](docs/architecture/)** — 系统设计、Brains & Sources、Schema Packs
- **[AI Agent 工作手册](CLAUDE.md)** — 面向 Claude Code / Codex 的开发规则
- **[AI 安装协议](INSTALL_FOR_AGENTS.md)** — 让 AI 帮你自动安装
- **[变更日志](CHANGELOG.md)** — 完整版本历史

---

## 近期更新

| 版本 | 说明 |
|------|------|
| **1.1.46** | 优化大文件导入失败的提示；共享模式 source 范围管理；Ollama 普通模型调通及 Dream 修复 |
| **1.0.83** | README 与当前桌面安装、Docker Postgres 首装、MCP 源范围和主知识库源说明对齐 |
| **1.0.82** | 新增 Docker Postgres 首次安装教程，面向 PGLite/WASM 启动异常的新用户 |
| **1.0.81** | Admin Console 的 Agent/API Key 源范围选择器排版优化 |
| **1.0.80** | MCP Agent/API Key 读取源范围管理；自然语言任务失败/跳过明细单独展示 |
| **Desktop 1.0.45** | 首次配置支持 PGLite 和 Docker Postgres；可保存主知识库源 ID 并同步设置默认 source |
| **Desktop M5** | GitHub Releases 自动发布与更新；启动后检查下载、安装前停止 sidecar、更新后自动迁移和健康检查 |
| **全量中文化** | Admin Console 所有页面、CLI 帮助、仪表盘、文档页已全部中文化 |

[查看完整变更日志 →](CHANGELOG.md)

---

## 许可证

MIT License。基于 [GBrain](https://github.com/garrytan/gbrain) 改造。
