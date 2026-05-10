# KOS Worker — Notion ↔ Knowledge OS Bridge

Notion Custom Agent 的 Cloudflare-edge worker，让 Notion Jarvis 可以
直接查询和操作 Knowledge OS。

## 架构

```
Notion AI Agent (📚 Knowledge Agent)
  → KOS Worker (Cloudflare edge, 4 tools)
    → https://kos.chenge.ink                        ← cloudflared tunnel
       → kos-compat-api.ts (Mac mini :7225, bun)    ← launchd-managed
         → gbrain CLI (Postgres-backed brain)
```

## 组件

### 1. Notion Worker (`src/index.ts`)
4 个 tools 供 Notion AI agent 调用：
- `kosQuery` — 知识库检索
- `kosIngest` — URL 或 markdown 摄入
- `kosDigest` — 知识变更摘要
- `kosStatus` — 健康状态

每次 fetch 配置了 240 s timeout（覆盖 cold ingest），超时会抛
明确的"KOS API timeout"错误而不是被 Cloudflare 平台静默判
"unreachable"。详见 [`docs/integration-clients.md`](../../docs/integration-clients.md)。

### 2. KOS API Server (`../../server/kos-compat-api.ts`)

Bun TypeScript HTTP server，监听 `127.0.0.1:7225`，实现 v1 `kos`
CLI 的兼容 API（`/query` `/ingest` `/digest` `/status` `/health`）。
通过 launchd plist `com.jarvis.kos-compat-api` 常驻；关联 Postgres
17 + pgvector 0.8.2 brain。

### 3. Cloudflared tunnel
将外部 `https://kos.chenge.ink` 路由到 `127.0.0.1:7225`，由
`com.jarvis.cloudflared` launchd job 管理。Worker 只看到 HTTPS
入口，不依赖 Tailscale 或裸 IP。

## 部署步骤

> **前置假设**：你已经在 Mac mini 上完成 KOS v2 主体安装（`gbrain`
> 已 `gbrain init`，brain 已就绪，launchd plists 已加载，
> cloudflared 已经把 `kos.chenge.ink` 路由到 `127.0.0.1:7225`）。
> 这一节只覆盖 Notion 边缘的 worker 部署。

### Step 1: 验证 KOS API 可达

```bash
# 本地直连
curl -sS -H "Authorization: Bearer $KOS_API_TOKEN" \
  http://127.0.0.1:7225/status | jq .total_pages

# 远程（Cloudflare tunnel）
curl -sS -H "Authorization: Bearer $KOS_API_TOKEN" \
  https://kos.chenge.ink/status | jq .total_pages
```

两条都应该返回相同的页数。如果远程 401 而本地 200，说明 token
对了但 `.env.local` 里的 token 跟 ntn env 设置的不一致；如果
远程超时或 502，说明 cloudflared 隧道没把 host 路由到正确端口
（参考 `~/.cloudflared/jarvis-office.yml` + token 隧道配置）。

### Step 2: 部署 Notion Worker

```bash
cd workers/kos-worker
ntn login                                # 如未登录
ntn workers deploy --name "kos-worker"

# 配置环境变量
ntn workers env set KOS_API_BASE "https://kos.chenge.ink"
ntn workers env set KOS_API_TOKEN "<匹配 Mac mini .env.local 里 KOS_API_TOKEN 的值>"
ntn workers env push
```

> **注意**：`KOS_API_BASE` 不要写成 `127.0.0.1:7225`、`localhost:7225`、
> Tailscale hostname 或 Mac mini 内网 IP。Notion edge 看不到任何这些。
> 唯一可达的入口是 `https://kos.chenge.ink`。

### Step 3: 创建 Notion Custom Agent

在 Notion 中创建 📚 Knowledge Agent，关联 kos-worker 的 4 个 tools。

### Step 4: 更新 Notion Jarvis 主路由

在 §4 混合路由调度中添加 Knowledge Agent 条目（触发关键词：
摄入、知识库、wiki、knowledge）。

## 本地测试

由于 `KOS_API_BASE` 默认 fallback 是 `http://localhost:7225`，
本地 dev 模式无需 ntn env push 即可测：

```bash
# 1. 确保本地 kos-compat-api 在跑（launchd 会自启，否则手动）
launchctl print gui/$(id -u)/com.jarvis.kos-compat-api | grep state

# 2. 直接 hit kos-compat-api
curl -sS -H "Authorization: Bearer $KOS_API_TOKEN" \
  http://127.0.0.1:7225/health
curl -sS -H "Authorization: Bearer $KOS_API_TOKEN" \
  http://127.0.0.1:7225/status
curl -sS -X POST -H "Authorization: Bearer $KOS_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"question":"harness engineering 是什么"}' \
  http://127.0.0.1:7225/query
curl -sS -H "Authorization: Bearer $KOS_API_TOKEN" \
  "http://127.0.0.1:7225/digest?since=7"

# 3. 用 ntn 在本地执行 worker tools（自动加载 .env，使用 fallback URL）
ntn workers exec kosStatus --local
ntn workers exec kosQuery --local -d '{"question":"什么是 context engineering"}'
ntn workers exec kosIngest --local -d '{"url":"https://example.com"}'
```

## 故障排查

| 症状 | 可能原因 | 排查 |
|---|---|---|
| Notion agent 报 "KOS知识库超时不可达" | Cloudflare fetch timeout（30s 默认）触发但 server 仍在做 ingest | 看 Mac mini `kos-compat-api.stdout.log` 是否有同 URL 的 200 响应；若有，是客户端超时不是 server 故障。Worker `kosApi()` 现在统一 240s 超时，不应再误报 |
| `KOS API timeout after 240s` | 真的在 240s 内没完成（罕见，通常是 server 串行队列堆积） | `GET /status` 探活；server 健康但慢说明已有别的 ingest 在排队，等下次 5 分钟 cron 自动重试 |
| `KOS API error (401)` | `KOS_API_TOKEN` 在 ntn env 和 `.env.local` 不一致 | 重新 push：`ntn workers env set KOS_API_TOKEN "$(grep ^KOS_API_TOKEN ~/Projects/jarvis-knowledge-os-v2/.env.local | cut -d= -f2-)"` |
| `KOS API error (502/504)` | cloudflared 隧道断了，或者 kos-compat-api launchd job 挂了 | `launchctl print gui/$(id -u)/com.jarvis.kos-compat-api`；`launchctl print gui/$(id -u)/com.jarvis.cloudflared`；必要时 `launchctl kickstart -k` 重启 |
| `imported: true, warning: "embedding failed"` | Gemini API 配额 / 计费卡 / 临时 5xx | 不是 ingest 失败，页面已入库。手动补 embedding：`gbrain embed --slugs <slug>`；下次 dream-cycle 也会自动补 |

## 与上层文档的关系

- [`docs/integration-clients.md`](../../docs/integration-clients.md) —
  对所有外部客户端（含本 worker）的 contract，定义了 timeout / retry /
  embed-failure 处理三大规则。本 worker 的 `kosApi()` 实现就是这套规则
  在 Cloudflare edge 上的具体落地。
- [`workers/notion-poller/`](../notion-poller/) —
  in-repo 同伴 worker（push 模式：cron 推 Notion 改动到 brain）。
  本 worker 是 pull 模式（Notion AI agent 主动调）。
- [`skills/kos-jarvis/_archived/feishu-bridge/SKILL.md`](../../skills/kos-jarvis/_archived/feishu-bridge/SKILL.md) —
  归档:OpenClaw 飞书 skill 的 command-mapping 文档,2026-05-05 随
  Feishu signal-detector extension 退役一并归档。
