# KOS Worker — Notion ↔ Knowledge OS Bridge

Notion Custom Agent 的 worker，让 📚 Knowledge Agent 可以直接查询和写入 Knowledge OS。

## 架构 (post-2026-05-XX cutover, v3 wire)

```
Notion AI Agent (📚 Knowledge Agent)
  → KOS Worker (Notion edge, 3 tools)
    → https://kos.chenge.ink                          ← cloudflared tunnel (mbp-office)
       → gbrain serve --http (jarvis Mac :7225, Bun)  ← launchd-managed, OAuth 2.1 + MCP
         → Postgres 17 + pgvector 0.8.2 brain
```

**Wire**: OAuth 2.1 `client_credentials` grant + MCP JSON-RPC over HTTP (per
[`docs/EXTERNAL-CLIENTS-MCP-WIRE-HANDOFF.md`](../../docs/EXTERNAL-CLIENTS-MCP-WIRE-HANDOFF.md)).
Per-client `client_id` + `client_secret`; admin can revoke; every call audited
in `mcp_request_log` table.

**Previous wire** (Bearer `KOS_API_TOKEN` against `kos.chenge.ink` → `kos-compat-api.ts` on port 7225)
is retired — see [`docs/JARVIS-ARCHITECTURE.md` §6.28](../../docs/JARVIS-ARCHITECTURE.md#628-kos-compat-api-retire--mcp-over-http-cutover).

## 组件

### 1. Notion Worker (`src/index.ts`)
3 个 tools 供 Notion AI agent 调用：
- `kosQuery` — 知识库检索（返结构化 hits，agent 端 LLM 综合）
- `kosIngest` — URL 或 markdown 摄入（chunk + embed + 异步 fact extraction；
  entity-graph 由 dream-cycle 在 24h 内 backfill）
- `kosStatus` — 采样统计（最新 100 page 的 by_type 直方图）

每次 fetch 配置了 240 s timeout（覆盖 cold ingest）。OAuth token 每次 tool call
重新换发（per-call fresh，不缓存 — Notion Worker isolate reuse 语义未定）。

**kosDigest** (旧 v2 第 4 个 tool) 已 retire。patrol digest 仍由 fork-side
`kos-patrol` cron 写到 `~/brain/.agent/digests/patrol-*.md`（host-local），
Notion Agent 不再能拉。如需查看，ssh 到 brain host `cat` 文件，或看
OpenClaw `MEMORY.md` (`digest-to-memory` cron weekly Sun 22:00)。

### 2. gbrain serve --http (`../../bin/gbrain serve --http`)

上游 native MCP server，Bun binary，绑定 `127.0.0.1:7225`，启动通过
`com.jarvis.gbrain-serve-http` launchd plist（template 在
`scripts/launchd/com.jarvis.gbrain-serve-http.plist.template`）。

OAuth client 注册 + admin dashboard:
- 注册: `bin/gbrain auth register-client <name> --grant-types client_credentials --scopes "read write" --source default`
- Admin: `https://kos.chenge.ink/admin`（一次性 bootstrap token 在 stderr log，
  每次 launchctl restart 轮换 — `tail -30 server/gbrain-serve-http.stderr.log | grep -i 'admin.*token'`）

### 3. Cloudflared tunnel
将 `https://kos.chenge.ink` 路由到 `127.0.0.1:7225`，由 **mbp-office** 上的
cloudflared 隧道管理（不是 jarvis Mac 本机）。Worker 只看到 HTTPS 入口，
不依赖 Tailscale 或裸 IP。

> **跨机器 ops note**：cloudflared config 在 mbp-office，jarvis Mac 本机
> `~/.cloudflared/config.yml` 只 list `crs.chenge.ink → :8765` 跟本 worker
> 无关。修改 `kos.chenge.ink` 路由需 SSH 到 mbp-office。

## 部署步骤

> **前置假设**：jarvis Mac 上 KOS v2 主体已安装（`gbrain init`、Postgres
> brain、5 launchd 服务齐全、cloudflared 隧道已加 `kos.chenge.ink → :7225`）。
> 本节只覆盖 Notion 边缘的 worker 部署。

### Step 1: 验证 gbrain serve --http 可达

```bash
# 本地直连 (auth-less /health)
curl -sS http://127.0.0.1:7225/health | jq .
# expect: {"status":"ok","version":"0.35.6.0","engine":"postgres"}

# 远程 (Cloudflare tunnel)
curl -sS https://kos.chenge.ink/health | jq .
# 应返回相同 shape
```

如果远程 timeout 或 502，说明 mbp-office cloudflared 隧道还没把
`kos.chenge.ink` 路由到 jarvis Mac 的 `:7225`。SSH 到 mbp-office 修
cloudflared config + `launchctl kickstart -k` reload。

### Step 2: 注册 OAuth client + 配置 worker env vars

**一次性 OAuth client 注册**（在 jarvis Mac 上 Lucien 跑）:

```bash
mkdir -p ~/.gbrain/oauth-clients && chmod 700 ~/.gbrain/oauth-clients
bin/gbrain auth register-client "kos-worker" \
  --grant-types client_credentials --scopes "read write" --source default
# 输出 client_id + client_secret —— ONE-TIME show，secret 不可恢复
# 立刻保存:
cat > ~/.gbrain/oauth-clients/kos-worker.json <<EOF
{
  "client_id": "<paste here>",
  "client_secret": "<paste here>",
  "scopes": "read write",
  "registered_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "comment": "Notion 📚 Knowledge Agent worker (workers/kos-worker)"
}
EOF
chmod 600 ~/.gbrain/oauth-clients/kos-worker.json
```

如果丢失 client_secret：`bin/gbrain auth revoke-client <client_id>` 后重新 register。

**Worker env vars 推送**:

```bash
cd workers/kos-worker
ntn login                                # 如未登录
ntn workers env set KOS_MCP_BASE "https://kos.chenge.ink"
ntn workers env set KOS_OAUTH_CLIENT_ID "$(jq -r .client_id ~/.gbrain/oauth-clients/kos-worker.json)"
ntn workers env set KOS_OAUTH_CLIENT_SECRET "$(jq -r .client_secret ~/.gbrain/oauth-clients/kos-worker.json)"
ntn workers env push
ntn workers deploy --name "kos-worker"
```

> **注意**：`KOS_MCP_BASE` 不要写成 `127.0.0.1:7225`、`localhost:7225`、
> Tailscale hostname 或 Mac mini 内网 IP。Notion edge 看不到任何这些。
> 唯一可达的入口是 `https://kos.chenge.ink`。

### Step 3: 创建 / 更新 Notion Custom Agent

如果是首次创建：在 Notion 中创建 📚 Knowledge Agent，关联 kos-worker 的
**3 个 tools** (kosQuery / kosIngest / kosStatus)。

如果是从 v2 → v3 升级（旧 4 tool 版本已部署）：照
[`docs/NOTION-AGENT-UPDATE-CHECKLIST.md`](../../docs/NOTION-AGENT-UPDATE-CHECKLIST.md)
更新 — 主要是删 kosDigest 引用 + 调整 agent prompt 路由建议词。

### Step 4: 更新 Notion Jarvis 主路由

在 §4 混合路由调度中保留 Knowledge Agent 条目（触发关键词：
摄入、知识库、wiki、knowledge）。

## 本地测试

`KOS_MCP_BASE` 默认 fallback 是 `http://localhost:7225`，本地 dev 模式无需
ntn env push 即可测（前提：本机 gbrain serve --http 已起 + `.env.local` 含
OAuth client_id/secret）:

```bash
# 1. 确保本地 gbrain serve --http 在跑
launchctl print gui/$(id -u)/com.jarvis.gbrain-serve-http | grep state
# 或手动:
# bin/gbrain serve --http --port 7225 --bind 127.0.0.1 --public-url https://kos.chenge.ink

# 2. 直接 hit 上游 MCP (用 OAuth)
# 拿 access_token
TOK=$(curl -s -X POST http://127.0.0.1:7225/token \
  -d "grant_type=client_credentials" \
  -d "client_id=$(jq -r .client_id ~/.gbrain/oauth-clients/kos-worker.json)" \
  -d "client_secret=$(jq -r .client_secret ~/.gbrain/oauth-clients/kos-worker.json)" \
  -d "scope=read write" | jq -r .access_token)

# health (auth-less)
curl -sS http://127.0.0.1:7225/health

# MCP tools/list (验 OAuth + scope OK) — 注意 /mcp 默认返 SSE，
# 必须先 grep '^data: ' 抽 SSE data line 再 jq 解析
curl -sS -X POST http://127.0.0.1:7225/mcp \
  -H "Authorization: Bearer $TOK" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":"1","method":"tools/list"}' \
  | grep '^data: ' | sed 's/^data: //' | jq .

# MCP tools/call query (SSE 同样 wrap)
curl -sS -X POST http://127.0.0.1:7225/mcp \
  -H "Authorization: Bearer $TOK" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":"1","method":"tools/call","params":{"name":"query","arguments":{"query":"harness engineering 是什么"}}}' \
  | grep '^data: ' | sed 's/^data: //' | jq .

# 3. 用 ntn 在本地执行 worker tools (使用 .env 里的 client_id/secret)
ntn workers exec kosStatus --local
ntn workers exec kosQuery --local -d '{"question":"什么是 context engineering"}'
ntn workers exec kosIngest --local -d '{"markdown":"# Test\n\nworker smoke test body","title":"smoke-test","kind":"source"}'
```

`.env.local` (in `workers/kos-worker/`) 示例（local-only，gitignored）:

```
KOS_MCP_BASE=http://localhost:7225
KOS_OAUTH_CLIENT_ID=<your kos-worker client_id>
KOS_OAUTH_CLIENT_SECRET=<your kos-worker client_secret>
```

## 故障排查

| 症状 | 可能原因 | 排查 |
|---|---|---|
| Notion agent 报 "MCP HTTP 401" | OAuth client_id/secret 在 ntn env 跟本机 `~/.gbrain/oauth-clients/kos-worker.json` 不一致；或 client 已被 `gbrain auth revoke-client` | 验本地 `getAccessToken` 流程：`curl -X POST $KOS_MCP_BASE/token -d ...` 看返回；不一致就重新 `ntn workers env set` + `ntn workers env push`；revoke 后需重 register |
| "MCP HTTP 504" 或 worker timeout 240s | 真的 240s 内 server 没回（罕见，put_page on large markdown + embed 拥塞） | `GET /health` 探活；server 健康但慢说明已有别的 ingest 在 chunk + embed 排队，等几分钟 |
| "MCP HTTP 502" | cloudflared 隧道断了，或 gbrain-serve-http launchd job 挂了 | `launchctl print gui/$(id -u)/com.jarvis.gbrain-serve-http`；mbp-office cloudflared 状态；必要时 `launchctl kickstart -k` |
| "MCP query op error (insufficient_scope)" | kos-worker scope 不够（我们注册时给的是 `read write`） | 如果未来要调 admin op (get_stats / get_health admin / sync_brain)，重新 register `--scopes "read write admin"`；当前 kosStatus 走 list_pages 不需要 admin |
| kosIngest URL 模式返回 "fetch returned HTTP 403/404/empty" | X/Twitter / Cloudflare-保护页，worker 端 plain fetch 没 Tavily/FlareSolverr 能力 | 改 markdown 模式直接传内容；或独立 PR 加 worker → Tavily 直调（需 TAVILY_API_KEY env） |
| kosStatus total 跟本地 `gbrain status` 不符 | by design — kosStatus 是采样模式 (最新 100 page) | 看 response 的 `note` 字段；要精确数 ssh 跑 `gbrain status` 或 `gbrain doctor` |

## Rollback (atomic port re-use — pure launchctl swap on jarvis Mac)

Lucien chose 2026-05-17 atomic cutover via port re-use: kos-compat-api
booted out → freed `:7225` → gbrain-serve-http bootstrapped on same port.
Cloudflared `kos.chenge.ink` ingress unchanged across cutover, so rollback
is pure launchctl swap on jarvis Mac, **no mbp-office touch needed**.

1. **Brain-side swap-back** (jarvis Mac, ~5 s):
   ```bash
   launchctl bootout gui/$UID/com.jarvis.gbrain-serve-http
   rm ~/Library/LaunchAgents/com.jarvis.gbrain-serve-http.plist
   git mv server/_archived/kos-compat-api.ts server/
   git mv scripts/launchd/_archived/com.jarvis.kos-compat-api.plist.template scripts/launchd/
   cp scripts/launchd/com.jarvis.kos-compat-api.plist.template ~/Library/LaunchAgents/com.jarvis.kos-compat-api.plist
   # fill <FILL:KOS_API_TOKEN> from .env.local commented entry + <FILL:NANO_BANANA_API_KEY>
   launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.jarvis.kos-compat-api.plist
   curl -sS http://127.0.0.1:7225/health     # expect old Bearer wire shape
   ```
2. **Worker env revert**:
   ```bash
   cd workers/kos-worker
   git revert <kos-worker v3 commit>
   ntn workers env set KOS_API_BASE "https://kos.chenge.ink"    # 同 hostname
   ntn workers env set KOS_API_TOKEN "<old token from .env.local commented entry>"
   # v3 env vars (KOS_OAUTH_*) 不删（旧 v2 代码不读它们）
   ntn workers env push
   ntn workers deploy
   ```

完整流程参考 `docs/JARVIS-ARCHITECTURE.md` §6.28 "Rollback steps" 节。

## 与上层文档的关系

- [`docs/JARVIS-ARCHITECTURE.md` §6.28](../../docs/JARVIS-ARCHITECTURE.md) —
  完整 retire / cutover 故事
- [`docs/EXTERNAL-CLIENTS-MCP-WIRE-HANDOFF.md`](../../docs/EXTERNAL-CLIENTS-MCP-WIRE-HANDOFF.md) —
  MCP wire spec (给 mailagent / feishu / 任何 future caller 自己照写)
- [`docs/NOTION-AGENT-UPDATE-CHECKLIST.md`](../../docs/NOTION-AGENT-UPDATE-CHECKLIST.md) —
  Notion Custom Agent UI 端 v2→v3 升级 step-by-step
- [`docs/integration-clients.md`](../../docs/integration-clients.md) —
  对所有外部客户端（含本 worker）的 contract，定义了 timeout / retry / 错误处理三大规则
- [`skills/kos-jarvis/_archived/feishu-bridge/SKILL.md`](../../skills/kos-jarvis/_archived/feishu-bridge/SKILL.md) —
  归档:OpenClaw 飞书 skill 的 command-mapping 文档,2026-05-05 随
  Feishu signal-detector extension 退役一并归档。
