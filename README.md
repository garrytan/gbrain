# PMBrain — 项目管理知识大脑

PMBrain 是一个**纯本地、开箱即用**的项目管理知识大脑。把你的项目文档、会议纪要、需求文档、合同文件放进一个文件夹，AI 就能自动构建知识图谱、追踪进度、预警风险、生成报告。

基于 GBrain（Y Combinator 总裁 Garry Tan 开发的开源个人知识大脑）深度改造，保留完整知识管理能力，做了大量国产化修改，更符合国人的使用习惯。

---

## 核心能力

PMBrain 集成了 GBrain 的核心能力，安装后相当于给你的 AI 工具装了一个**有记忆的大脑**。

你的 AI 工具（CodeBuddy、Workbuddy、Codex、Cursor、Claude Code 等）原本每一次对话都是独立的，聊完就忘。有了 PMBrain，AI 可以搜索你存过的所有文档、笔记、对话记录，回答问题时带着历史上下文。

- **混合搜索引擎**：向量搜索 + 关键词 + 知识图谱三重融合，搜索质量远高于单纯的关键词匹配
- **知识图谱**：自动从文档中提取人物、公司、项目之间的关联关系
- **MCP 接口**：CodeBuddy、Workbuddy、Codex、Cursor、Claude Code、QwenPaw 等 AI 工具在对话中直接调用知识库
- **GUI 管理控制台**：通过浏览器导入资料、浏览知识库、审批观点、运行自然语言任务、配置 MCP 接入、查看任务监控和系统诊断
- **数据本地化**：知识库存储在你自己的电脑或服务器上，不会上传到第三方云端
- **双引擎架构**：支持本地 PGLite 和 Docker Postgres / Supabase 两种部署方式

## 特色功能

### 导入即用，无需转换格式

支持国人常用的办公文档格式，直接导入，无需手动转换。`.docx`、`.pdf`、`.xlsx` 等文件在内存中自动抽取正文后直接进入搜索和向量化流程，**不产生中间文件**。

| 格式 | 说明 |
|------|------|
| `.md` / `.mdx` | Markdown 笔记 |
| `.docx` / `.doc` / `.wps` | Word 文档 |
| `.pdf` | PDF 文档 |
| `.xlsx` / `.xlsm` / `.xls` | Excel 表格 |
| `.csv` | 表格数据 |
| `.png` / `.jpg` / `.jpeg` / `.gif` / `.webp` / `.heic` / `.heif` / `.avif` | 图片和扫描件 |
| `.mp3` / `.wav` / `.m4a` | 音频文件（自动转写） |

```powershell
pmbrain import "D:\项目文档" --include-office
pmbrain import "D:\扫描件" --include-images
```

支持图片/扫描件导入；如需文字搜图、以图搜图，需要额外配置支持图片向量化的多模态 embedding 模型。

### 全量中文化

PMBrain 的管理后台、CLI 帮助、仪表盘、文档页、常用操作提示均已翻译为中文。命令行参数名和 JSON 字段等技术标识保持英文，在日常使用中降低理解门槛。

### 增量同步

注册文件夹为 source 后，每次启动自动同步更新的文件。

```powershell
pmbrain sources add my-project --path "D:\项目文档"
pmbrain sync --source my-project
```

### 原始数据和知识库数据可视化

启动 Admin Console 后，可以在浏览器里查看原始数据导入、知识库页面、观点审批、数据源分布、向量化覆盖率、MCP 接入状态和后台任务健康情况。

```powershell
pmbrain serve --http --port 3131
```

浏览器打开 `http://localhost:3131/admin`，即可进入 PMBrain 知识控制台。

CLI 仍然支持可溯源搜索，每个搜索结果可以查看评分来源：

```powershell
pmbrain search "项目进度" --explain
```

### 自然语言 AI 控制台

Admin Console 不是传统后台，而是面向 AI Agent 的本地控制台。你可以直接输入自然语言任务：

- `导入文件夹路径\需求.md`
- `同步所有知识库`
- `查一下项目相关资料`
- `运行系统诊断`

系统会调用已配置的对话模型识别意图，校验后映射到 PMBrain 允许的操作。所有任务历史记录保存在本地，可回填复用。

### Dream 周期与观点审批

Dream 周期会把知识库维护拆成多个阶段运行，包括同步、抽取、概念整理、候选观点提取、观点打分、校准画像、嵌入刷新和项目管理检查等。当前真实阶段可通过命令查看：

```powershell
pmbrain dream --help
```

其中 `propose_takes` 会从页面正文中抽取“候选观点”，先写入 `take_proposals`，状态为 `pending`。这些候选观点不会直接进入正式知识；需要在 Admin Console 的 **观点审批** 页面查看原文依据后，手动接受或拒绝。接受后的观点才会进入正式 `takes`，后续 `grade_takes` 和 `calibration_profile` 才会基于这些正式观点工作。

安全预览推荐先运行 dry-run：

```powershell
pmbrain dream --phase propose_takes --dry-run --json --source pmgbrain --max-pages 25
```

dry-run 模式下 `propose_takes` 只统计哪些页面需要调用 LLM，不调用 LLM，也不写入候选观点，避免误扫大库或长时间阻塞。

### 多模型支持（国内可用）

内置 19 类 AI 提供商（含自定义 OpenAI 兼容接口），国内可直接使用：

| 提供商 | 用途 |
|--------|------|
| 智谱 BigModel | 向量嵌入、对话 |
| MIMO 小米 | 搜索扩展、对话 |
| DeepSeek | 对话 |
| OpenAI / Anthropic / Ollama | 嵌入/对话/重排序 |
| 自定义 OpenAI 兼容接口 | 本地或局域网 Qwen、vLLM、LM Studio、Xinference、LocalAI 的嵌入/对话 |

---

## 使用场景

### 个人知识库

- **对话沉淀**：把你和 AI 的每一次讨论保存下来。不管在 CodeBuddy、Workbuddy、Codex、Cursor 还是 Claude Code，所有工具的知识沉淀到同一个地方
- **文档归集**：日常文档、办公文件、笔记直接导入，支持 Word、PDF、Excel、Markdown、音频等格式
- **增量同步**：注册文件夹后每次开机自动更新，只处理新增和修改的文件

### 项目经理

把项目文档、会议纪要、需求文件放入一个文件夹，AI 自动构建知识图谱，追踪进度，预警风险，生成周报。

### 团队协作

PMBrain 作为团队的共享知识库，MCP 接入 AI 工具后，每个人在对话中直接调取知识。新成员加入可以搜索历史讨论和决策记录。

### AI 编程辅助

在 CodeBuddy、Workbuddy、Codex、Cursor 中开发时，PMBrain 作为知识库后端，AI 可以搜索技术方案、查看历史决策，回答更准确。

---

## 安装

本文档中所有命令示例均使用 `pmbrain`。要使用此方式，需先通过 `bun install -g .` 或 `bun install -g github:...` 全局安装。如果未全局安装，请将 `pmbrain` 替换为 `bun run src/cli.ts`。

### Windows 桌面版（开箱即用）

Windows 桌面端目前仍属于内测版本，安装或使用过程中可能会存在问题；如遇到安装失败、启动异常或迁移报错，请联系客服 `zyhnijt`。

完整的新用户前置条件、首次配置、老用户升级和故障处理请阅读：[PMBrain 桌面版安装与首次使用](docs/desktop/安装与首次使用.md)。

运行最新的 `PMBrain-Windows-x64-Setup-*.exe` 后，桌面端会优先读取现有 `.pmbrain/config.json`，并兼容读取旧版 `.gbrain/config.json`；已有数据库和 API Key 会直接沿用，只有本机没有配置时才打开首次配置向导。首次配置时，用户只需选择 PGLite 本地数据库或 Docker Postgres、配置所需模型并选择知识库目录；本地 Qwen 等 OpenAI 兼容服务可为普通模型和向量模型分别填写 Base URL、模型 ID，并共用可选 API Key。桌面端会生成 `config.json`、初始化数据库、注册知识库 Source，并固定本机管理员 bootstrap token。

安装包已内置固定版本、校验过的 Bun x64 baseline 运行时、PGLite 数据库及其 WASM 资源，可兼容不支持 AVX2 的较老 x64 CPU；选择 PGLite 时不需要另装 Bun、Docker 或 Postgres。首次安装会使用安装包内置的 PMBrain sidecar 自动创建数据库并执行迁移，不依赖系统 PATH、`gbrain.exe` 或用户手动命令。配置完成后可在桌面端生成 CodeBuddy、Workbuddy、Cursor、Claude Code、Codex、QwenPaw 的 MCP 接入配置，并在写入前备份原配置、合并 `pmbrain` 节点和执行 MCP smoke test。QwenPaw 2.x 通过其本机 API 安全更新 DriverCard 和凭证库，完整写入 Bearer Header，并以 QwenPaw 实际工具列表再次确认连接；旧版继续兼容 `%USERPROFILE%\.qwenpaw\config.json`，不会覆盖已有客户端。数据库模式可在配置页中切换；切换失败时会恢复原配置。

`3221225501` 对应 Windows `0xC000001D`（非法 CPU 指令），属于内置运行时启动失败，切换 Docker Postgres 不能解决。Desktop 1.0.61 起安装包改用 Bun x64 baseline 并在写配置前执行运行时自检。只有运行时自检通过、随后仍出现明确的 PGLite/WASM 初始化错误时，才建议按 [首次安装使用 Docker Postgres 教程](docs/desktop/首次安装使用DockerPostgres.md) 准备数据库并填写连接地址。

桌面端会自动从 GitHub Releases 检查和下载更新。安装更新前会安全停止本地 sidecar；更新后首次启动会先执行幂等数据库迁移，再启动服务并完成健康检查。升级不会覆盖已有数据库地址、模型 Key、知识库目录或 MCP 配置。

### 方式一：Docker + Postgres（推荐，Windows 优先）

PGLite 在 Windows 上有 WASM 兼容性问题，推荐优先使用 Docker：

```powershell
# 1. 安装 Docker Desktop

# 2. 启动 Postgres（含 pgvector 插件）
docker run -d `
  --name pmbrain-postgres `
  -e POSTGRES_USER=postgres `
  -e POSTGRES_PASSWORD=postgres `
  -e POSTGRES_DB=pmbrain `
  -p 5433:5432 `
  -v pmbrain-postgres-data:/var/lib/postgresql/data `
  pgvector/pgvector:pg16

# 3. 确认 pgvector 可用
docker exec -it pmbrain-postgres psql -U postgres -d pmbrain -c "CREATE EXTENSION IF NOT EXISTS vector;"

# 4. 安装 Bun
powershell -c "irm bun.sh/install.ps1 | iex"

# 5. 全局安装 PMBrain
bun install -g github:zhengyunhui123-dev/PMBrain

# 6. 配置（编辑 ~/.pmbrain/config.json）
# {
#   "engine": "postgres",
#   "database_url": "postgresql://postgres:postgres@127.0.0.1:5433/pmbrain",
#   "embedding_model": "zhipu:embedding-3",
#   "embedding_dimensions": 1024,
#   "zhipu_api_key": "你的智谱Key"
# }

# 7. 初始化
pmbrain init

# 8. 验证
pmbrain doctor

# 9. 启动 GUI 管理控制台
pmbrain serve --http --port 3131
```

启动后浏览器打开 `http://localhost:3131/admin`。首次登录需要使用终端打印的 Admin Token，或让 AI Agent 生成一次性管理员登录链接。

### 方式二：PGLite 本地安装（macOS / Linux 推荐）

Windows 上 PGLite WASM 运行时可能存在兼容性问题，如果遇到 `PGLite failed to initialize` 错误，请改用 Docker 方式。

```powershell
# 1. 安装 Bun
powershell -c "irm bun.sh/install.ps1 | iex"

# 2. 全局安装
bun install -g github:zhengyunhui123-dev/PMBrain

# 3. 配置（编辑 ~/.pmbrain/config.json）
# { "engine": "pglite", ... }

# 4. 初始化
pmbrain init --pglite

# 5. 验证
pmbrain doctor

# 6. 启动 GUI 管理控制台
pmbrain serve --http --port 3131
```

> 安装后 CLI 命令是 `pmbrain`，任何路径下直接 `pmbrain <命令>` 即可。旧版 `gbrain` 命令会继续作为兼容别名保留。

### 方式三：从源码安装

```powershell
git clone https://github.com/zhengyunhui123-dev/PMBrain.git
cd PMBrain
bun install

# 可选：注册为全局命令，后续可直接使用 pmbrain
bun install -g .

pmbrain init --pglite
pmbrain serve --http --port 3131
```

> 如果跳过 `bun install -g .`，则需用 `bun run src/cli.ts` 代替 `pmbrain`。

如果修改了 Admin Console 前端代码，先运行：

```powershell
bun run build:admin
```

### 方式四：Supabase 托管数据库

适合不想自己管理服务器的团队。详见 [安装文档](docs/INSTALL.md)。

### 方式五：AI 智能体自动安装

让 Claude Code、Codex 等 AI 智能体自动完成安装。详见 [AI 安装协议](INSTALL_FOR_AGENTS.md)。

### 导入数据

```powershell
# 导入项目文件夹
pmbrain sources add my-project --path "D:\项目文档"
pmbrain sync --source my-project

# 或者一次性导入（含 Office 文档）
pmbrain import "D:\项目文档" --include-office
```

### 每日使用

```powershell
# 1. 保存当前对话/笔记
pmbrain capture "要记住的内容"

# 2. 搜索已有知识
pmbrain search "关键词"

# 3. 同步增量
pmbrain sync --all
pmbrain embed --stale

# 4. 打开 GUI 管理控制台
pmbrain serve --http --port 3131
```

浏览器访问 `http://localhost:3131/admin` 后，可以通过图形界面完成导入、浏览、MCP 接入、任务监控和系统诊断。

---

## AI 提供商配置速查

PMBrain 配置存放在 `~/.pmbrain/config.json`（兼容 `~/.gbrain/config.json`）。以下为国内用户推荐的配置方案：

| 功能 | 推荐提供商 | 模型标识 | 配置字段 |
|------|-----------|---------|---------|
| 向量化（必需） | 智谱 BigModel | `zhipu:embedding-3`（1024d） | `zhipu_api_key` |
| 对话/搜索扩展 | MIMO 小米 | `mimo:mimo-v2.5-pro` | `mimo_api_key` |
| Dream 提炼/判定 | MIMO 小米 | `mimo:mimo-v2.5-pro` | `mimo_api_key` |
| 对话备用 | DeepSeek | `deepseek:deepseek-v4-flash` | `deepseek_api_key` |
| 对话/嵌入（海外） | OpenAI | `openai:text-embedding-3-small`（1536d） | `openai_api_key` |

> 向量化是搜索的基础，建议优先申请智谱 Key。智谱 `embedding-3` 每百万 token 仅 0.01 美元，国内可直接访问 [open.bigmodel.cn](https://open.bigmodel.cn) 申请。

```json
{
  "zhipu_api_key": "你的智谱Key",
  "mimo_api_key": "你的MIMO Key",
  "deepseek_api_key": "你的DeepSeek Key"
}
```

普通对话模型可以直接修改 `chat_model`。切换向量模型请使用桌面端“保存修改并重启”，或运行 `pmbrain config set embedding_model <provider:model>`：PMBrain 会先调用新模型验证连接和实际维度，验证通过后仅将旧向量标记为待重算并立即使用新模型重建；原始页面、分块和知识内容不会被删除。若重算中断，未完成分块保持待处理状态，下一次运行 Dream（默认包含 `embed` 阶段）会自动继续；从旧版本升级时，Dream 也会自动识别并修复模型标识与当前配置不一致的历史向量。

---

## MCP 接入 AI 工具

安装好 PMBrain 后，可以通过 MCP 协议让 AI 编程工具直接调用知识库。

### 本地 STDIO 模式

直接在 AI 工具的 MCP 配置文件（`mcp.json`）中添加：

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

### HTTP 模式（带管理后台）

```json
{
  "mcpServers": {
    "pmbrain": {
      "command": "pmbrain",
      "args": ["serve", "--http", "--port", "3131"]
    }
  }
}
```

启动后浏览器打开 `http://localhost:3131/admin` 可查看管理后台。Admin Console 的 MCP 接入页内含 **CodeBuddy 使用教程**，可查看 API Key 创建、`.mcp.json` 配置和连接验证的完整步骤。

如果希望每次重启后管理员初始令牌保持不变，可以设置环境变量：

```powershell
$env:PMBRAIN_ADMIN_BOOTSTRAP_TOKEN="至少32位的安全随机字符串"
pmbrain serve --http --port 3131
```

### HTTP + Bearer Token 模式（推荐）

适用于本地 AI 工具通过 HTTP 协议接入，支持权限隔离和撤销：

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

### ChatGPT Secure MCP Tunnel

PMBrain 支持通过 OpenAI Secure MCP Tunnel 接入 ChatGPT，无需开放公网端口或配置公网域名。进入 Admin Console 的 **MCP 接入** 页面，填写 Tunnel ID 和 Runtime API Key，即可生成独立的 `pmbrain-chatgpt` profile、只读本地凭证并运行 Doctor、启动或停止 tunnel-client。

- ChatGPT 连接方式选择 **Tunnel**，身份验证选择 **无身份验证**
- tunnel-client 会在本机请求中注入只读 Bearer Token，ChatGPT 无法看到 Token
- ChatGPT 只发现读取工具，写入和管理工具仍由服务端拒绝
- PMBrain 与 tunnel-client 均由用户手动启停，不创建 Windows 服务或开机任务

完整步骤见 [ChatGPT 接入指南](docs/mcp/CHATGPT.md)。

### 在线/远程服务器的配置方式

如果 PMBrain 部署在远程服务器上：

```json
{
  "mcpServers": {
    "pmbrain": {
      "command": "pmbrain",
      "args": ["serve", "--http", "--port", "3131", "--bind", "0.0.0.0"]
    }
  }
}
```

> 远程部署需要配置 OAuth 认证，详见 [MCP 部署指南](docs/mcp/)。

### 让 AI 帮你配置

把下面这段发给你的 AI 编程工具，它就会自动帮你配好 MCP：

```
请帮我配置 PMBrain 的 MCP 服务。
PMBrain 安装在当前电脑。
MCP 配置如下：
{
  "mcpServers": {
    "pmbrain": {
      "command": "pmbrain",
      "args": ["serve"]
    }
  }
}
请把它添加到当前工具的 MCP 配置文件中。
```

---

## 项目结构

```
PMBrain/
├── admin/                  # Admin Console 前端源码（React + Vite）
├── desktop/                # Electron Windows 桌面端、配置向导与 MCP 接入助手
├── src/                    # 源代码
│   ├── cli.ts              # CLI 入口
│   ├── core/               # 核心引擎、搜索、AI 网关、梦境周期
│   │   ├── engine.ts       # BrainEngine 接口
│   │   ├── operations.ts   # 所有操作定义（~47 个）
│   │   ├── search/         # 混合搜索（向量 + 关键词 + RRF + 多查询）
│   │   ├── ai/             # AI 网关 + 18 个提供商配方
│   │   ├── cycle/          # Dream 周期各阶段
│   │   └── facts/          # 事实队列系统
│   ├── commands/           # CLI 命令和 HTTP Admin Console 后端
│   └── mcp/                # MCP 服务器
├── skills/                 # AI 智能体技能（43 个）
├── templates/              # 模式包模板
│   └── pm-schema-pack/     # PM 模式包
├── docs/                   # 完整文档目录（100+ 文件）
├── scripts/                # 构建/测试/检查脚本
├── evals/                  # 评估基准
├── recipes/                # 对话模式配方
├── 项目管理/               # 变更台账、Bug 修复、配置指南
├── test/                   # 测试套件
├── CLAUDE.md               # AI Agent 工作手册
└── AGENTS.md               # AI 开发规则
```

---

## 待实现

- [ ] **Dream 本地沉淀与手写观点**：将 Dream 产物稳定保存到本地，使其能结合本地 wiki 页知识库使用，并支持用户手动写入观点
- [ ] **观点时间线合并规则**：同一个知识点出现不同结果时，按时间线采纳最新观点，同时保留历史依据
- [ ] **国内视频网站导入**：B站等国内视频平台内容直接导入知识库
- [ ] **Electron 桌面版发布完善**：M1-M3、M5 已完成，待正式代码签名
- [ ] **Surrogate-pair 安全截断**：修复 emoji / 4 字节 CJK 字符切半导致的 JSON 解析错误

---

## 文档与帮助

- **Admin Console 内置文档页**：启动服务后进入 `/admin` → 侧边栏"帮助中心"→ 使用文档 / 常见问题
- **[完整安装文档](docs/INSTALL.md)**：Docker、PGLite、Supabase 三种部署方式详解
- **[架构文档](docs/architecture/)**：系统设计、数据流、组件关系
- **[MCP 部署指南](docs/mcp/)**：OAuth 认证、远程部署、安全配置
- **[AI Agent 工作手册](CLAUDE.md)**：面向 Claude Code / Codex 的开发规则
- **[AI 安装协议](INSTALL_FOR_AGENTS.md)**：让 AI 帮你自动安装
- **[MCP 接入指南](docs/mcp/)**：包含 Claude Code、Claude Cowork、Perplexity、ChatGPT 等 AI 工具的接入方式

---

## 近期更新

| 更新 | 说明 |
|------|------|
| **PMBrain 1.0.83** | README 与当前桌面安装、Docker Postgres 首装、MCP 源范围和主知识库源说明对齐 |
| **PMBrain 1.0.82** | 新增 [Docker Postgres 首次安装教程](docs/desktop/首次安装使用DockerPostgres.md)，用于 PGLite/WASM 启动异常或希望使用稳定数据库的新用户 |
| **PMBrain 1.0.81** | 优化 Admin Console 的 Agent/API Key 源范围选择器排版；写入源独立显示，读取源改为单列可扫描多选列表 |
| **PMBrain 1.0.80** | 补齐 MCP Agent/API Key 读取源范围管理；新增 Agent 和 API Key 默认使用主源并支持多选读取源；自然语言任务失败/跳过明细单独展示 |
| **PMBrain 1.0.79；Desktop 1.0.45** | 补齐主知识库源在 Admin GUI、MCP 接入页和桌面配置页的可见与设置入口；桌面端可保存主知识库源 ID 并同步设置默认 source |
| **Windows 桌面端 1.0.45** | 当前桌面端仍处内测，首次配置支持 PGLite 和 Docker Postgres；遇到 Windows PGLite/WASM 异常时推荐切换 Docker Postgres |
| **Windows 桌面端 1.0.28** | 修复全新 Windows 首次安装链路：安装相关迁移不再依赖 PATH 上的 `gbrain.exe`、`pmbrain.exe` 或 `git`；doctor 与迁移错误提示改为 PMBrain 命令 |
| **Admin Token 输出优化** | `pmbrain serve --http` 在未显式隐藏 token 时会直接打印可复制的 Admin Token，方便手动登录 Admin Console |
| **Dream 自动读取优化** | Dream synthesize 支持直接读取 Codex `.jsonl` 对话和中文会议转写，会议文本会在 UTF-8 / GB18030 间自动选择正确解码 |
| **运行稳定性增强** | `op_checkpoints.completed_keys` 增加数组形态保护，避免异常 JSONB 值破坏恢复进度；新增 `pmbrain advisor` 只读诊断入口和 Git source durability 命令 |
| **Windows 桌面端 1.0.23-1.0.25** | 安装包明确标注 Windows x64；收紧 sidecar 启动失败与恢复重试的子进程清理；补齐 PGLite、Office/PDF 导入所需运行时依赖，避免安装版缺模块 |
| **Windows 桌面端 M5** | GitHub Releases 自动发布与更新：启动后检查并下载，安装前停止 sidecar，更新后迁移数据库并通过健康检查后启动；已有本地配置自动沿用 |
| **Windows 桌面端 M2/M3** | 首次配置向导内置 PGLite，可切换 Docker Postgres，固定管理员 token、注册知识库 Source，并为 CodeBuddy、Workbuddy、Cursor、Claude Code、Codex 生成或合并 MCP 配置及执行 smoke test |
| **Windows 桌面壳 M1** | Electron 托管本地 PMBrain sidecar，自动选择端口、进入管理员安全会话，并提供异常恢复与日志入口 |
| **全量中文化** | Admin Console 所有页面、CLI 帮助、仪表盘、文档页已全部中文化 |
| **Office 文档直接导入** | `.docx/.pdf/.xlsx/.csv/.wps` 无需转 Markdown，直接导入知识库 |
| **图片/扫描件入口** | 支持图片/扫描件导入；图片检索需配置支持图片向量化的多模态 embedding 模型 |
| **AI 提供商扩展** | 新增 MIMO 小米 Recipe，智谱支持对话，DeepSeek 支持扩展 |
| **Admin Console 大幅升级** | 侧边栏分组导航、文档页、自然语言任务历史、系统诊断持久化 |
| **观点审批流程** | `propose_takes` 产生候选观点后进入 Admin Console 审批，可查看原文依据后接受或拒绝 |
| **Dream 分批处理** | `pmbrain dream --phase propose_takes --max-pages <n>` 和 Admin 观点审批页均可限制单次处理页数 |
| **锁续期诊断** | `doctor` 已包含 `lock_renewal_health`，并继续在 `batch_retry_health` 中汇总断连审计线索 |
| **Dream dry-run no-LLM** | `propose_takes --dry-run` 只统计需 LLM 的页面，不调用模型、不写候选观点 |
| **模型诊断修复** | `models doctor` 已能真实探针对话、扩展和向量化模型可用性 |
| **品牌统一为 PMBrain** | CLI 命令、MCP 标识、配置目录已全面切换为 `pmbrain` |
| **Source 管理增强** | `sources adopt` 命令、自动 Source ID 生成、未注册 Source 历史收编 |

---

## 许可证

MIT License。基于 [GBrain](https://github.com/garrytan/gbrain) 改造。
