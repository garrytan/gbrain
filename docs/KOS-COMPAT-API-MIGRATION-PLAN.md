# KOS-Compat-API → gbrain serve --http 完全切换 Migration Plan

> **Status**: DRAFT — 评估文档（未批准执行）
> **Author**: Claude Opus 4.7
> **Created**: 2026-05-17
> **Companion**: [`docs/KOS-JARVIS-CONSOLIDATION-PLAN.md`](KOS-JARVIS-CONSOLIDATION-PLAN.md) Tier 5
> **Trigger**: 用户态度「即便涉及到比如 kos http 的更新，那也要去做，这样一劳永逸」
> **Reading order**: §1 现状 → §3 关键决策点（SSoT 反转）→ §6 ROI → §7 Decision matrix

---

## 1. 当前 wire（status quo, 2026-05-17 fork v0.35.6.0）

### 1.1 fork-side server: `server/kos-compat-api.ts`

**Total**: 661 LoC，运行在 `kos-compat-api` launchd service (PID 9074)，绑定 `127.0.0.1:7225`，cloudflared tunnel 暴露成 `https://kos.chenge.ink`。

Bearer auth via `KOS_API_TOKEN` env (single static token, no rotation, shared by all callers)。

| Endpoint | LoC | 行为 | SSoT 方向 |
|---|---|---|---|
| `GET /health` | ~5 | `{ status: "ok", brain: <slug> }` | n/a |
| `GET /status` | ~30 | 直接 PGLite/Postgres 读 `pages` 表，返 by_type / by_kind / total_pages histogram。Bypass MCP 100-row cap | DB read |
| `GET /digest` | ~50 | 读最新 `~/brain/.agent/digests/patrol-*.md` 或 DB summary，返 markdown | Disk read |
| `POST /query` | ~80 | spawn `gbrain ask <question>` subprocess，capture stdout，return JSON | DB read |
| `POST /ingest` | ~250 | **filesystem-canonical**: 收 `{ url, slug?, markdown?, kind?, title? }` → 若 markdown=null 走 `url-fetcher` 取页 → 生成 frontmatter → **写 disk** `~/brain/<kind-dir>/<slug>.md` → **git commit** → **spawn** `gbrain sync --repo ~/brain` → return `{ slug, page_id, embedded: bool }` | **Disk → DB** |
| 共用 (auth, frontmatter shaping, kind-to-dir map, error handling) | ~250 | — | — |

### 1.2 External callers

| Caller | Host | 当前 wire | 频率 | KOS_API_TOKEN 持有 |
|---|---|---|---|---|
| **Notion Knowledge Agent** (kos-worker) | Notion 云上 worker | `POST kos.chenge.ink/query`, `POST kos.chenge.ink/ingest`, `POST kos.chenge.ink/digest` 等 — JSON body, Bearer auth | ad-hoc per agent turn | ✓ |
| **OpenClaw feishu cron** | macbook-pro-office (mbp-office) | `POST kos.chenge.ink/ingest` for selected feishu signals (历史 wire，自 2026-05-05 signal-detector 退役后实际不再用) | dormant | ✓ |
| **mailagent kos push** (方案 B, GitHub issue #1) | macbook-pro-office | 计划: `POST kos.chenge.ink/ingest` per email | ~1-50/day (post-launch) | 计划持有 |
| **Lucien CLI / curl** | macbook-pro (本机) | 偶尔 `curl localhost:7225/status` | ad-hoc | n/a |

### 1.3 KOS-v1 wire shape (固化在外部 client 代码里)

Notion Knowledge Agent + OpenClaw feishu 都依赖固定 JSON shape：

```http
POST /query  HTTP/1.1
Authorization: Bearer ed85...
Content-Type: application/json

{"question": "Lucien 的 fork 策略"}
```

```http
POST /ingest HTTP/1.1
Authorization: Bearer ed85...
Content-Type: application/json

{
  "markdown": "# Title\n\n...",
  "title": "Some subject",
  "source": "mailagent:<message_id>",
  "kind": "source",
  "tags": ["mailagent-ingest"]
}
```

---

## 2. 目标 wire（migration target: `gbrain serve --http`）

### 2.1 上游 `gbrain serve --http` 现状（v0.34+）

绑定 `127.0.0.1:<port>`，提供：

- `POST /mcp` — MCP JSON-RPC over HTTP, **Bearer auth via OAuth 2.1 access token**（不是 static token）
- `POST /token` — OAuth 2.1 token endpoint (client_credentials / authorization_code grants)
- `POST /authorize` — OAuth 2.1 authorize endpoint (PKCE-based authorization_code grant)
- `POST /register` — RFC 7591 Dynamic Client Registration
- `POST /revoke` — OAuth 2.1 token revocation
- `GET /.well-known/oauth-authorization-server` — RFC 8414 metadata discovery
- `GET /health` — liveness ping (auth-less)
- `GET /admin/*` — admin React SPA (Dashboard / Agents / RequestLog / Login)
- `POST /admin/api/*` — admin programmatic API
- `GET /admin/auth/:nonce` — magic-link redemption

### 2.2 MCP operations 覆盖 (29 个，relevant to migration)

| MCP op | 替代 fork endpoint | 等价度 |
|---|---|---|
| `query` | `POST /query` | **1:1**, params: `{ question, top_k? }` |
| `search` | `POST /query` (full-text 路径) | 1:1 |
| `list_pages` | `GET /status` (作为 aggregation 基础) | partial — fork 端要在 client 做 group-by-type histograms |
| `get_stats` | `GET /status` | 1:1 if 上游已加 by_kind histograms |
| `get_health` | `GET /health` | 1:1 |
| `put_page` | `POST /ingest` | **partial** — 见 §3.1 SSoT 反转 |
| `get_page`, `delete_page`, `restore_page`, `purge_deleted_pages` | (fork 未暴露) | 新能力（OAuth 后可对 client 暴露） |
| `add_tag`, `remove_tag`, `get_tags` | (fork 未暴露) | 新能力 |
| `add_link`, `remove_link`, `get_links`, `get_backlinks`, `traverse_graph` | (fork 未暴露) | 新能力（graph 操作） |
| `add_timeline_entry`, `get_timeline` | (fork 未暴露) | 新能力 |
| `think` | (fork 未暴露) | 新能力（LLM-driven reasoning） |
| `run_doctor`, `sync_brain`, `get_versions`, `revert_version` | (fork 未暴露) | 新能力（运维） |
| `get_brain_identity` | (fork 未暴露) | 新能力（identity） |

**结论**: query / status / health 切 MCP 简单；**ingest 是核心难点**（见 §3.1）。

### 2.3 目标 wire 示例

```http
POST /mcp HTTP/1.1
Authorization: Bearer <OAuth 2.1 access_token, expires_in 3600>
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "id": "1",
  "method": "tools/call",
  "params": {
    "name": "query",
    "arguments": { "question": "Lucien 的 fork 策略", "top_k": 10 }
  }
}
```

Response:
```json
{
  "jsonrpc": "2.0",
  "id": "1",
  "result": {
    "content": [
      { "type": "text", "text": "<JSON-serialized query result>" }
    ]
  }
}
```

---

## 3. 关键决策点（必须先决再写代码）

### 3.1 ⚠️ SSoT 反转：disk-canonical → DB-canonical

**这是整个 migration 的核心决策**。

#### 当前 fork 模型（disk-canonical）
- `~/brain/<kind-dir>/<slug>.md` 是 SSoT
- DB (`pages` 表 + `chunks` + `links` 等) 是从 disk 派生的 cache
- 任何 ingest 都先写 disk（git tracked），再 `gbrain sync` 拉进 DB
- 好处：
  - **git history** 是完整变更记录
  - **外部 grep / Obsidian / IDE** 可以直接消费 markdown 文件
  - **disaster recovery 简单** — disk 在 = brain 在，DB 可以从 disk 重建
  - 跟 KOS v1 (Python/shell) 的 mental model 一致

#### 切到 `put_page` 模型（DB-canonical）
- DB 是 SSoT
- Disk 可能仍存在（如果 reverse-write 启用），但不是 source of truth
- `put_page` 直接写 DB（chunks + embeds + tags + links + timeline 全自动）
- 失去：
  - **git history** — DB 写不进 git（除非显式 `gbrain export` + commit）
  - **disk grep** — 文件没了或不同步
  - **disaster recovery** — DB 丢了只能从 backup 恢复
  - Obsidian / IDE 直接看 brain 的能力

#### 折中方案：保留 fork `/ingest`，只切 `/query` + `/status`

- `/query` + `/status` 切 MCP（无 SSoT 问题，纯读）
- `/ingest` 保留 fork-side filesystem-canonical
- `/digest` 保留 fork-side（读 disk 上 patrol report）
- **net trim**: ~110 LoC (从 661 → ~550 LoC)，**不消除 fork-side server**

#### 完全切换方案：所有 endpoint 退役 fork

- 所有 caller 切到 MCP
- Fork `/ingest` retire → callers 直接 `put_page` MCP
- `~/brain/` filesystem 仅 read-only（Obsidian / grep 用 export 出来的 snapshot）
- **net trim**: -661 LoC + 减 1 launchd service + 加 1 上游 `gbrain serve --http` service
- **代价**: SSoT 反转 + 失去 git history + Obsidian 受限

**这个决策必须 Lucien 拍板**。我的偏向：**折中方案**（trim /query + /status，保留 /ingest + /digest）— SSoT 反转的 architectural cost 不值 ~250 LoC 的 trim。

但 v3 也可以考虑：**fork 加一个 BrainExporter daemon**，订阅 DB 变更，写 markdown 到 disk + git commit，实现 DB-canonical + disk-mirror。这是新 fork code（~150 LoC），但保留 disk grep + git history。也算 fork 长期方向。

### 3.2 OAuth 2.1 vs 单 Bearer token

当前 `KOS_API_TOKEN` 是 single static token，所有 client 共享，**无过期 / 无 revoke / 无 audit**。

上游 `gbrain serve --http` 是 OAuth 2.1：
- 每个 client 注册一次（POST `/register` 或预先创建）
- 拿 `client_id` + `client_secret`
- 每次调用前先 `POST /token` 换 `access_token`（有 expiry）
- per-client audit log 在 `mcp_request_log` 表

**好处**：
- 单 client 泄漏不影响别人
- 可 revoke 单 client
- 谁调用了什么有 audit

**代价**：
- 每个 external client 改 wire（拿 token 流程）
- 注册 OAuth client 是一次性 setup，但需要存 client_secret（mailagent / kos-worker / OpenClaw 都要存）
- token refresh logic 在 client 端

**Lucien-only 场景**: 私有 brain, 3 个 client 全是自己控制, OAuth 的 audit/revoke 收益对个人用户低，但 token 过期 + refresh 的 client-side 复杂度真实存在。

### 3.3 `/digest` 的去留

`/digest` 读 fork-generated `~/brain/.agent/digests/patrol-*.md`。这是 kos-patrol Phase 6 输出（fork-unique）。

3 个选项：
- (a) **stays fork-side** — 不切 MCP，保留 fork endpoint 或者 callers 直接 `cat` 文件（如果 callers 跟 brain host 同机或有 fs access）
- (b) **暴露成 MCP custom op** — fork 自加 `get_patrol_digest` op 到 server-http 的 tool list（需要 patch upstream serve-http 或写 fork plugin）
- (c) **retire** — 改让 patrol digest 直接 push 到 callers（OpenClaw MEMORY.md 已有 `digest-to-memory` 做这事）

**推荐 (a)** — `/digest` 跟 disk 文件耦合，强行 MCP 化没收益。

---

## 4. Endpoint-by-endpoint migration map（完整切换方案）

| Fork endpoint | 目标 MCP op | client-side 改造 | server-side trim |
|---|---|---|---|
| `GET /health` | `GET /health` (上游已有 auth-less) | 端点路径不变 | -5 LoC |
| `GET /status` | `tools/call name="list_pages"` + client aggregation OR `tools/call name="get_stats"` | wire 改 JSON-RPC + OAuth token + client-side histograms | -30 LoC |
| `POST /query` | `tools/call name="query" arguments={question, top_k}` | wire 改 JSON-RPC + OAuth | -80 LoC |
| `POST /ingest` | `tools/call name="put_page" arguments={slug, content}` | **SSoT 反转 — caller 自己构造完整 markdown + frontmatter；disk write + git commit 失效** | -250 LoC |
| `GET /digest` | (a) stays fork OR (b) custom MCP op | (a) 不动 OR (b) 切 MCP | (a) 0 OR (b) -50 LoC |
| Bearer auth 共用 | OAuth 2.1 | client 拿 token 流程 | -100 LoC |
| Frontmatter shaping / kind-to-dir map | n/a (上游不 touch disk) | n/a | -100 LoC |
| Error handling 共用 | MCP 标准 error envelope | client 解析新 error shape | -50 LoC |

**Net LoC trim**（完整切换）: **-665 LoC**（接近全 retire 661 LoC + 5 LoC 折扣是因为 `/digest` 保留场景下 `-50` 不发生）

**Net add**:
- 1 新 launchd service `com.jarvis.gbrain-serve-http.plist`（替代 kos-compat-api plist）
- 1 个 OAuth-client-id-secret 文件每个 caller（`~/.gbrain/oauth-clients/{kos-worker,mailagent,openclaw}.json`）
- 3 个 external client 各 +50-100 LoC OAuth token 管理 + JSON-RPC framing

---

## 5. 外部 Client 改造工作量

### 5.1 Notion Knowledge Agent (kos-worker)

- **当前**: `workers/kos-worker/src/index.ts`，调用 `kosQuery` / `kosIngest` 等 tool（暴露给 Notion Custom Agent），内部 HTTPS POST `kos.chenge.ink/<endpoint>` with Bearer
- **改造**:
  - 一次性 OAuth client register（手工或 `/register`）
  - 在 `index.ts` 加 OAuth token cache + refresh logic（~50 LoC）
  - 改 `kosQuery` impl: HTTPS POST `/mcp` JSON-RPC + parse MCP result envelope（~30 LoC）
  - 改 `kosIngest` impl: 调 `put_page` MCP — **但 SSoT 反转后**，agent 写的 page 没 disk file 也没 git history（design impact，需 Lucien 接受）
- **工作量**: ~1 day + 1 周稳定期（看 Notion Agent 实战）
- **风险**: Notion Worker runtime 对 OAuth flow 友好度未知（需要 verify Notion Worker runtime 能存 secret + handle redirect）

### 5.2 OpenClaw feishu cron (mbp-office)

- **当前**: 自 2026-05-05 signal-detector 退役后 dormant，可能根本没有 active caller
- **改造**: 如果重启 → 同 kos-worker 套路
- **工作量**: ~0.5 day if 重启
- **风险**: 低 — dormant 状态

### 5.3 mailagent kos push (方案 B, 未落地)

- **未来 wire**: 计划 POST `/ingest`
- **改造**: 如果 migration 之前 mailagent 已经实现方案 B → 同 kos-worker；如果 mailagent 还没实现 → 直接 spec 成 MCP `put_page` 即可
- **建议**: **如果 migration 真要做，时机选在 mailagent 方案 B 落地之前** — 直接 spec MCP，跳过 KOS-v1 wire
- **工作量**: 等于方案 B 本身 + ~30 LoC OAuth/MCP framing

### 5.4 Lucien CLI / curl (本机)

- 改 `curl localhost:7225/status` → `curl -H "Bearer $TOKEN" localhost:<port>/mcp -d '...JSON-RPC...'`
- 或者写一个 `gbrain-curl` wrapper handle OAuth + JSON-RPC framing
- **工作量**: ~1 h wrapper if 需要

---

## 6. Phased Migration Plan（如果决定执行）

### Phase 0: 准备 + 决策（~1 week）

- Lucien 拍板 §3.1 SSoT 反转 vs 折中（推荐折中：trim /query + /status，保留 /ingest + /digest）
- 决定 §3.2 OAuth 2.1 vs 保留 fork Bearer token（推荐 OAuth — 既然要切就一波到位）
- 确认 §3.3 `/digest` 选 (a) stays fork

### Phase 1: 并行运行 dual-mode（~1 week）

- 启动 `gbrain serve --http` 作为 sibling service（独立 port, e.g. 7226）
- 创建 launchd plist `com.jarvis.gbrain-serve-http.plist`
- OAuth setup：注册 3 个 clients（kos-worker, mailagent, openclaw），生成 client_id/client_secret
- kos-compat-api 不动，两个 server 并存
- 写一个 smoke test script: 同一 query 同时打 kos-compat-api `/query` 和 gbrain-serve `/mcp` `tools/call query`，diff 结果（验证语义等价）

### Phase 2: External client 逐个迁移（~2-3 weeks）

按顺序（最低风险 → 最高风险）：

1. **Lucien CLI / curl**（本机）— 写 `gbrain-curl` wrapper，本人验证 OAuth flow + JSON-RPC framing 通畅
2. **OpenClaw feishu cron** — 当前 dormant，可以低风险切（错了也不影响 production）
3. **mailagent kos push（方案 B）** — 等方案 B 自己落地 + 直接 spec MCP
4. **Notion Knowledge Agent**（最高风险，最后切）— Lucien 实际使用频率最高的 caller，需要 1-2 周稳定期观察

每个 client 切完后保留 1 周观察期，验证 latency / error rate / 用户体验。

### Phase 3: kos-compat-api retire（~3 day）

- 监控 1 周：kos-compat-api access log 应该 0 access（所有 caller 已切走）
- `launchctl bootout` + `rm ~/Library/LaunchAgents/com.jarvis.kos-compat-api.plist`
- `git mv server/kos-compat-api.ts → server/_archived/`
- 删 fork docs 里 `kos-compat-api` 引用 + 加 §6.28 retire story
- net: -661 LoC fork code + -1 launchd service

### Phase 4: 长期收尾（持续）

- 持续监控 `gbrain serve --http` 运行（OAuth token rotation，admin dashboard 看 mcp_request_log）
- 把 `kos.chenge.ink` cloudflared tunnel 指到新 port
- 评估是否进一步加 fork BrainExporter（DB → disk reverse-write，保留 git history + Obsidian）

**总工作量**: Phase 0-4 累计 **4-6 weeks**（含 1-2 周稳定期）；实际 active dev 时间 **~5-7 day**

---

## 7. Risks

| Risk | 概率 | 影响 | Mitigation |
|---|---|---|---|
| SSoT 反转后 disk 文件渐渐过期 → grep / Obsidian 看到 stale 内容 | 高 | 中 | 加 fork BrainExporter daemon（DB→disk reverse-write）OR 折中方案保留 /ingest |
| OAuth token rotation 失败 → caller 突然 401 | 中 | 高 | 各 client 加 refresh-on-401 logic + 告警 |
| Notion Worker runtime 不支持 OAuth flow | 低 | 高 | Phase 1 提前验证；不支持就放弃 Notion 这一路 |
| MCP JSON-RPC overhead 比 直接 JSON 慢 | 低 | 低 | benchmark Phase 1 confirm; MCP 一般 +5-10ms 开销 |
| upstream `gbrain serve --http` 在 fork brain (3138 pages) 上 buggy | 低 | 高 | Phase 1 dual-mode dry run 验证 |
| put_page 不能 reproduce fork frontmatter shape（kind/source_of_truth/source_refs/tags） | 中 | 中 | 验证 put_page 接受 caller-supplied YAML frontmatter；若不支持，提 upstream PR |
| OpenClaw / Notion 上 OAuth secret 泄漏 | 低 | 高 | OAuth 比 single Bearer 反而好（per-client revoke），但 client_secret 仍要 secure store |
| migration 期间 brain ingest 出现 gap | 中 | 中 | Phase 1 dual-mode 期间两条 wire 都写一段时间，acceptance 标准是新 wire 数据 = 旧 wire 数据 |

---

## 8. ROI 分析

### 8.1 收益（complete switchover）
- **-661 LoC fork code**（最大单笔 fork shrinkage）
- **-1 launchd service**（kos-compat-api）
- **+1 launchd service**（gbrain-serve-http）→ 净 service 数 = 0
- **+ OAuth audit / revoke / per-client identity**
- **+ 上游 admin dashboard 免费拿到**（React SPA: Dashboard / Agents / RequestLog）
- **+ 上游 sync_freshness / `recall --pulse` 等新 features 直接可用**（不用 fork 端 re-implement）
- **fork 长期方向**：往 fork-only fork-unique 业务逻辑（/digest, BrainExporter, digest-to-memory）收缩，infrastructure 走上游

### 8.2 代价
- **4-6 weeks elapsed time**（实际 dev ~5-7 day）
- **SSoT 反转的 architectural impact**（除非选折中方案）
- **OAuth 复杂度** vs 当前 single Bearer token 的简洁
- **migration 期间风险**（dual-mode 期间 brain 可能短时间 inconsistent）
- **Notion Worker / OAuth 兼容性未知风险**

### 8.3 真正的 "一劳永逸" 是什么

用户原话"一劳永逸"暗示：**做完之后长期不再维护 fork 这块**。

**完整切换** 真正一劳永逸的部分：
- ✓ /query, /status — 切了 MCP 后跟随 upstream 改进（search rank, embeddings 等）自动受益
- ✓ OAuth - 上游持续维护
- ✗ /ingest — fork-unique filesystem-canonical 不在上游路线图，**反向写 disk** 是 fork 长期负担 (无论是 fork BrainExporter 还是手工 export)
- ✗ /digest — fork-only kos-patrol 产物，不会有上游归属

**结论**: "完全 retire kos-compat-api" 节省的是 661 LoC，但 fork 仍要 own /ingest + /digest 的等价物（要么 fork BrainExporter ~150 LoC，要么接受 disk SSoT 丢失）。真实净 fork shrinkage 是 **~400-500 LoC**（不是 661）。

---

## 9. Decision matrix

### 9.1 何时启动 migration

启动条件（满足任一即可）：
- Notion Knowledge Agent 出现 maintenance 痛点（latency / bug / feature gap），正好一波重构
- mailagent 方案 B 准备落地（trigger #1）— 直接 spec MCP，跳过 KOS-v1 中间态
- 上游 v0.37+ 加了 BrainExporter 或类似 DB→disk reverse-write feature（消除 §3.1 SSoT 反转代价）
- fork 维护出现疲劳（kos-compat-api 出现实际 bug 或 scaling 痛点）
- Lucien 想用上游 MCP 新 ops（think / get_backlinks / traverse_graph / put_page 等扩展能力）

### 9.2 何时跳过 migration

跳过条件（满足任一即维持现状）：
- 当前 kos-compat-api 跑得好，0 痛点
- Notion Knowledge Agent runtime 不支持 OAuth 2.1 flow（致命阻塞）
- Lucien 不愿意接受 SSoT 反转 + 不愿意写 fork BrainExporter
- 没有 dev bandwidth（4-6 weeks elapsed）

### 9.3 推荐路径（综合 §3 + §8）

按推荐顺序：

1. **当下（2026-05-17）**: **跳过完整 migration**。当前 kos-compat-api 无痛点；Lucien 拍板的工程时间应该花在更高 ROI 的事（mailagent 方案 B / 上游 sync 节奏 / 新 features）。
2. **触发条件出现时（如 mailagent 方案 B 落地）**: 启动**折中方案** — 只 trim /query + /status 到 MCP，保留 /ingest + /digest fork-side。net trim ~110 LoC，零 SSoT 反转代价，零 OAuth 复杂度（保留 fork Bearer for /ingest + /digest，OAuth 仅 for /query + /status）。**约 2 day 工作量**。
3. **长期（v0.37+ 或上游 BrainExporter 出现）**: 重新评估**完整 migration**，含 SSoT 反转 + fork BrainExporter 替代。

**当下立即行动**: ❌ 不启动。**写本 doc 即是行动** —— 把决策框架 + 触发条件 + 详细 plan 留档，等条件出现直接执行。

---

## 10. Appendix

### 10.1 gbrain serve --http endpoint reference

参见 `src/commands/serve-http.ts`（1116 LoC）。

### 10.2 完整 MCP operations 清单

29 operations: get_page, put_page, delete_page, restore_page, purge_deleted_pages, list_pages, search, query, takes_list, takes_search, takes_scorecard, takes_calibration, think, add_tag, remove_tag, get_tags, add_link, remove_link, get_links, get_backlinks, traverse_graph, add_timeline_entry, get_timeline, get_stats, get_health, get_brain_identity, run_doctor, get_versions, revert_version, sync_brain.

参见 `src/core/operations.ts`。

### 10.3 OAuth setup commands (when ready to start)

```bash
# Start gbrain serve --http (Phase 1)
gbrain serve --http --port 7226 --bind 127.0.0.1

# Register OAuth client (e.g. for kos-worker)
gbrain admin oauth register \
  --client-name "Notion Knowledge Agent" \
  --client-type confidential \
  --redirect-uri "https://kos-worker.notion.so/oauth/callback"
# → outputs client_id + client_secret

# Client uses client_credentials grant for service-to-service:
curl -X POST http://localhost:7226/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials&client_id=...&client_secret=..."
# → returns access_token (3600s expiry)

# Use access_token for MCP call
curl -X POST http://localhost:7226/mcp \
  -H "Authorization: Bearer <access_token>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":"1","method":"tools/call","params":{"name":"query","arguments":{"question":"..."}}}'
```

### 10.4 Related docs

- [`docs/JARVIS-ARCHITECTURE.md`](JARVIS-ARCHITECTURE.md) §6.26 v0.35.6.0 sync, §6.27 notion-poller retire
- [`docs/KOS-JARVIS-CONSOLIDATION-PLAN.md`](KOS-JARVIS-CONSOLIDATION-PLAN.md) §M2-B (2026-05-15 verdict (c)：don't touch — 本 doc 是该 verdict 的反面 case study)
- [`server/kos-compat-api.ts`](../server/kos-compat-api.ts) — fork current implementation (661 LoC)
- [`src/commands/serve-http.ts`](../src/commands/serve-http.ts) — upstream target (1116 LoC)
- [`src/core/operations.ts`](../src/core/operations.ts) — MCP operations source of truth

---

## TL;DR

**Tier 5 完整 migration 是可执行的，但当下 ROI 不正**：
- 净 LoC trim **~400-500**（不是 661，因为 /ingest 仍需 fork 等价物）
- 4-6 weeks elapsed + SSoT 反转 architectural cost + OAuth setup
- 当前 kos-compat-api 无痛点 → **暂不启动**

**推荐折中方案** when first trigger condition appears（mailagent 方案 B 落地 / Notion Agent 重构 / 上游 BrainExporter 出现）：
- 只 trim /query + /status 到 MCP（~110 LoC）
- 保留 /ingest + /digest fork-side
- 2 day 工作量，零 SSoT 反转代价

**本 doc 的价值**: 决策框架 + 触发条件 + 详细 plan 留档；条件出现时不用重新评估，直接按 §6 Phase 0-4 执行。
