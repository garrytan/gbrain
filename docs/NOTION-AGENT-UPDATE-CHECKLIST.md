# Notion Knowledge Agent — v2 → v3 升级 checklist

Lucien-facing。Step-by-step 操作清单，配合 `workers/kos-worker` v3 wire 部署
完成后在 Notion 端做的事。

**前置**: 这份 checklist 假设你已经按 [`workers/kos-worker/SETUP.md`](../workers/kos-worker/SETUP.md)
完成了 OAuth client 注册 + worker env vars 推送 + `ntn workers deploy`。

**为什么需要这份**: worker 端把 4 个 tool 砍到 3 个（kosDigest 永久下线），
LLM synthesis 路径也变了（从 worker 双层 LLM → agent 单层 LLM）。
Notion Custom Agent 的 prompt 和路由建议词需要相应调整，否则 agent 会
继续尝试不存在的 kosDigest 工具或基于错的体验描述路由请求。

---

## Step 0: 前置确认

```bash
# 1. 验证 worker 切完 + 3 tool 可用
cd workers/kos-worker
ntn workers exec kosQuery --local -d '{"question":"smoke test"}'
ntn workers exec kosStatus --local
ntn workers exec kosIngest --local -d '{"markdown":"# Test\n\nworker upgrade smoke","title":"v3-upgrade-smoke","kind":"source"}'

# 2. 远程 deploy 状态健康
ntn workers sync status      # 应全 HEALTHY
ntn workers runs list | head # 看最近 run 无 401 / 5xx
```

任一失败 → 别动 Notion UI，先排查 worker / OAuth / gbrain-serve-http。

---

## Step 1: Notion Custom Agent UI 操作

打开 Notion → 切到 📚 Knowledge Agent (你在 `docs/integration-clients.md`
里记录过的 Custom Agent)。

### 1.1 Tools tab

刷新 tool list (页面右上角刷新 icon 或 reload 整个 agent 面板)。

**期望看到**:
- `kosQuery` (Knowledge Query)
- `kosIngest` (Knowledge Ingest)
- `kosStatus` (Knowledge Status (sampled))

**不应再看到**:
- `kosDigest` ← 如果还在，说明 worker 没重新 deploy；回到 Step 0 重跑
  `ntn workers deploy`

### 1.2 Agent prompt / system message

打开 agent 的主 prompt 编辑界面（"Edit instructions" 或类似入口）。

**删掉**所有 kosDigest 引用。常见处:
- "你可以通过 kosDigest 获取知识库最近变化" → 删
- 在 "工具使用指南" / "Tool usage hints" 段里 kosDigest 描述行 → 删
- 在路由示例里 "「最近知识库变化」→ 调 kosDigest" → 改成下面
  「Step 2.3 测试 3」的话术

**更新 kosStatus 描述**:
旧描述可能写 "kosStatus 返回 brain 完整页数 + 类型分布"。
**改成**: "kosStatus 返回最新 100 page 的采样统计 (sampled mode)。
若用户问精确全量数字，回答「采样 N 页见 by_type 直方图；精确总数需在
brain host 跑 \`gbrain status\`」。"

**更新 kosQuery 描述** (可选):
旧描述可能写 "返编译级 LLM 综合答案"。新行为是 raw retrieval (worker
不做 LLM synthesis，agent 自己综合)。一句话改: "kosQuery 返回结构化
retrieval hits (JSON array)，agent 端基于此综合最终答案"。

**更新 kosIngest 描述 — URL 模式 caveat**:
加一句: "URL 模式只能抓取公开页；X/Twitter / Cloudflare-保护页会返登录墙，
这类内容应该让用户先复制 markdown 文本，再用 markdown 模式传入"。

### 1.3 路由 / trigger 关键词

如果你在 Notion Jarvis 主路由里设了「触发关键词」 (per §4 混合路由调度)，
检查关键词列表是否含「digest」「digest 摘要」「最近变化」。**保留**这些
关键词（用户问这类问题 Knowledge Agent 仍然要应答），但 agent 内部别再
路由到 kosDigest — 改成回答「digest 工具已下线，请直接看 brain host 上
\`~/brain/.agent/digests/\` 或 OpenClaw \`MEMORY.md\` (digest-to-memory 每周
日 22:00 写)」。

---

## Step 2: 端到端冒烟测试

在 Notion 里跟 📚 Knowledge Agent 真实对话。每条 prompt 后看响应是否
预期。

### 2.1 kosQuery 路径 (基础检索)

```
你: Lucien 的 fork 策略是什么？
```

期望: agent 调 kosQuery → 拿到结构化 retrieval hits → LLM 综合答案，
应该提到 garrytan/gbrain fork、CLAUDE.md fork rules、monthly upstream
sync cadence 等。

如果返回 "MCP query HTTP 401" → OAuth client_id/secret 在 ntn env 跟
`~/.gbrain/oauth-clients/kos-worker.json` 不一致；
`ntn workers env set` 重推 + `ntn workers env push`。

### 2.2 kosIngest 路径 (markdown)

```
你: 帮我把这段笔记存进知识库，标题是「2026 年 Q2 路线图回顾」：
"""
今年 Q2 重点：上游 sync 月度化、fork 收缩 11→10 active dirs、…
"""
```

期望: agent 调 kosIngest with `{markdown, title, kind: "source"}` → 返
`{imported: true, slug: "sources/2026-...", status: "created_or_updated", chunks: N}` →
agent 确认入库。

随后:
```
你: 查一下 2026 Q2 路线图
```
kosQuery 应该能拉到刚写入的 page (vector embed 写完立刻可查)。

### 2.3 kosDigest 替代回答

```
你: brain 最近有哪些变化？
```

期望: agent 回答「kosDigest 工具已在 2026-05 下线。要看 patrol 日报
请在 brain host 上看 \`~/brain/.agent/digests/patrol-<date>.md\` (`kos-patrol`
每天 08:07 写)，或看 OpenClaw \`MEMORY.md\` 里 \`[knowledge-os]\` 段
(`digest-to-memory` 每周日 22:00 cron)。要看页面增量可以问我 kosStatus，
我给你最新 100 page 的类型分布。」

**不应该** 尝试调 kosDigest 然后报 "tool not found"。

### 2.4 kosStatus 路径 (sampled)

```
你: brain 有多少 page？什么类型？
```

期望: agent 调 kosStatus → 拿到 `{sampled_pages: 100, by_type: {...}, note: "..."}` →
回答「采样 100 个最新 page，by_type 直方图为 source: 70, concept: 15, ...。
若要精确全量总数，brain host 上跑 \`gbrain status\`」。

---

## 运维 notes

### 每次重启 gbrain-serve-http 后，admin bootstrap token 轮换

```bash
# 在 jarvis Mac 上
tail -30 /Users/chenyuanquan/Projects/jarvis-knowledge-os-v2/server/gbrain-serve-http.stderr.log | grep -i 'admin.*token'
```

token 用来登 `https://kos.chenge.ink/admin` (admin dashboard 看
mcp_request_log / 注册新 client / revoke 老 client)。

worker 的 OAuth `client_credentials` 不受 bootstrap token 轮换影响 —
client_id + client_secret 长期有效，直到你显式 revoke。

### kos-worker per-tool-call 拿 token

worker 每次 tool execute 调一次 `POST /token` 拿新 access_token (1 小时
TTL，但每次新 fetch；不缓存)。这给每个调用加 100-300ms 但不需要任何
client-side refresh 逻辑。

如果你看 worker stderr (`ntn workers runs logs <runId>`) 频繁出现
"OAuth /token timeout"，说明 gbrain-serve-http 或 cloudflared 不稳；
排查 launchctl 状态 + cloudflared 隧道健康。

### 第 5 个 OAuth client 用途

如果之后需要给 mailagent / 飞书 / 其他 caller 一个 OAuth client:

```bash
bin/gbrain auth register-client "<name>" \
  --grant-types client_credentials --scopes "read write" --source default
```

存 secret 到 `~/.gbrain/oauth-clients/<name>.json`，handoff 给 caller
按 [`docs/EXTERNAL-CLIENTS-MCP-WIRE-HANDOFF.md`](EXTERNAL-CLIENTS-MCP-WIRE-HANDOFF.md)
spec wire。

---

## Rollback (atomic port re-use — pure launchctl swap, no cloudflared touch)

Lucien chose 2026-05-17 same-session cutover with port re-use strategy:
kos-compat-api booted out → port freed → gbrain-serve-http bootstrapped on
same `:7225`. Cloudflared `kos.chenge.ink` ingress is unchanged across
cutover, so rollback is pure launchctl swap on jarvis Mac.

**Step A — Brain-side swap back** (jarvis Mac, ~5 s):

```bash
cd ~/Projects/jarvis-knowledge-os-v2
launchctl bootout gui/$UID/com.jarvis.gbrain-serve-http
rm ~/Library/LaunchAgents/com.jarvis.gbrain-serve-http.plist
git mv server/_archived/kos-compat-api.ts server/
git mv scripts/launchd/_archived/com.jarvis.kos-compat-api.plist.template scripts/launchd/
cp scripts/launchd/com.jarvis.kos-compat-api.plist.template ~/Library/LaunchAgents/com.jarvis.kos-compat-api.plist
# Edit deployed plist: fill <FILL:KOS_API_TOKEN> from .env.local commented entry
#                     fill <FILL:NANO_BANANA_API_KEY> from .env.local
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.jarvis.kos-compat-api.plist
curl -sS -H "Authorization: Bearer $KOS_API_TOKEN" http://127.0.0.1:7225/health
```

**Step B — Worker env back to old wire** (C, deploy):

```bash
cd workers/kos-worker
git revert <kos-worker v3 commit>     # 或 git checkout <pre-v3-commit-sha> -- src/index.ts SETUP.md
ntn workers env set KOS_API_BASE "https://kos.chenge.ink"
ntn workers env set KOS_API_TOKEN "<从 .env.local 或 1Password 取旧 token>"
# v3 env vars (KOS_OAUTH_*) 不删，老 v2 代码不读它们
ntn workers env push
ntn workers deploy
```

**Step C — Notion UI** (L): 把 kosDigest 描述加回 (按 Step 1.2 反向操作)。

完整 rollback 还可参考 [`docs/JARVIS-ARCHITECTURE.md` §6.28](JARVIS-ARCHITECTURE.md#628-kos-compat-api-retire--mcp-over-http-cutover)
的 "Rollback steps" 节。

---

## 与上层文档的关系

- [`docs/JARVIS-ARCHITECTURE.md` §6.28](JARVIS-ARCHITECTURE.md#628-kos-compat-api-retire--mcp-over-http-cutover) — 完整 retire 故事 + 架构 diff
- [`workers/kos-worker/SETUP.md`](../workers/kos-worker/SETUP.md) — worker 部署 + OAuth client 注册
- [`docs/EXTERNAL-CLIENTS-MCP-WIRE-HANDOFF.md`](EXTERNAL-CLIENTS-MCP-WIRE-HANDOFF.md) — 给 mailagent / feishu / future caller 自己照着写
