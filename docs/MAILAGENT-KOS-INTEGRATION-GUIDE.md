# MailAgent ⇄ KOS 接入与使用指南

> **读者**：把 KOS（gbrain）作为 skill/tool 接入 MailAgent 应用内 chat LLM 的工程同学。
> **目标**：让邮件 chat AI 能正确、稳定地从 KOS 检索/写入知识。
> **状态**：本指南所有调用均于 **2026-06-12 对 `https://kos.chenge.ink` 实测通过**。
> **配套**：底层 wire 细节见 [`EXTERNAL-CLIENTS-MCP-WIRE-HANDOFF.md`](./EXTERNAL-CLIENTS-MCP-WIRE-HANDOFF.md)（本指南是它之上的"用法层"）。

---

## 0. 先说你们遇到的"查不到邮件" —— 根因与结论

**权限本来就是对的，consumer client 一直能读 `mailagent-emails`。** 我用你们的 consumer client、走 `https://kos.chenge.ink/mcp`、跑你们 handoff 里一模一样的调用复现，结果全部命中：

| 调用 | 结果 |
|---|---|
| `query {"query":"Latigo"}`（不带 source_id） | ✅ 命中 `companies/latigo` |
| `query {"query":"Latigo","source_id":"mailagent-emails"}` | ✅ 命中 `people/cory-white`（引用 `sources/email/1000000005`） |
| `query {"source_id":"omada"}`（授权内） | ✅ 命中 |
| `query {"source_id":"gbrain-docs"}`（**未授权**） | ⛔ `permission_denied`（证明授权是精确生效的，不是 admin 全开） |

你们当时拿到 0，是**测试时点早于授权生效 / 邮件嵌入完成**，加上下面两个**用法误区**。修正方式很简单：

1. **用新 mint 的 token**（token 1h 过期，旧 token 401 而不是 0）。
2. **要原始邮件命中就带 `source_id:"mailagent-emails"`** —— 不带时走联邦检索，`default` 源里 dream cycle 合成的实体/概念页常常排在原始邮件之前（通常这正是更好的答案，但如果你们要的是邮件本身就得限定源）。

**不需要改 KOS 配置，也不要走 handoff 里"改用 bulk client 做 chat 检索"的备选** —— 保持 consumer client 这套更干净。

---

## 1. 凭证：两个 client，别用混

| client | 用途 | 写源 | 读范围(federated_read) | 你们的 env |
|---|---|---|---|---|
| **`mailagent`** (consumer) | **应用内 chat：跨源检索 + chat-save** | `default` | `{default, mailagent-emails, omada}` | `KOS_OAUTH_CLIENT_*` |
| `mailagent-bulk` | **仅**邮件批量 ingest | `mailagent-emails` | `{mailagent-emails}` | `MAILAGENT_BULK_CLIENT_*` |

- **chat 的工具调用一律用 consumer (`mailagent`)。** 它既能跨 3 个源读，也能把对话沉淀写回 `default`。
- `mailagent-bulk` **只**用于你们后台批量把邮件灌进 `mailagent-emails`，**不要**拿它做 chat 检索（它只读得到邮件源，读不到 `default`/`omada`，语义也不对）。
- consumer 的 `client_id` 是 `gbrain_cl_348583a30da6b50808f8a0c2ad7333951dee5031c5ae4c3ce941b2d76bd40f03`（client_id 非机密，secret 才是）。
- **secret 丢了无法找回**：`bin/gbrain auth revoke-client <id>` 再 `register-client` 重发（KOS 侧 Lucien 操作）。没有 update 命令。

---

## 2. Token 流程（OAuth 2.1 client_credentials）

```bash
curl -s -X POST https://kos.chenge.ink/token \
  -d grant_type=client_credentials \
  -d client_id="$KOS_OAUTH_CLIENT_ID" \
  -d client_secret="$KOS_OAUTH_CLIENT_SECRET"
# → {"token_type":"bearer","expires_in":3600,"scope":"read write","access_token":"gbrain_at_…"}
```

- **TTL = 3600s（1 小时）。** 客户端要缓存 token 并在过期前/收到 401 后重新 mint。
- **401 ≠ 没权限**，几乎总是 token 过期或打错 client。**永远不要把 401 当成"查不到结果"。**
- **两层 scope，别混淆**（这是最大的概念坑，见 §4）：
  - **OAuth scope**（`read`/`write`）：能不能读/写，token 里有。
  - **source scope**（`federated_read`）：能读哪些源，**不在 token 里**，每次调用实时从服务端读。

---

## 3. MCP wire（`POST /mcp`，JSON-RPC 2.0）

请求头（三个都必须）：

```
Authorization: Bearer <access_token>
Content-Type: application/json
Accept: application/json, text/event-stream
```

- 调用：`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"<tool>","arguments":{…}}}`
- 列工具：`method:"tools/list"`。
- **`client_credentials` 不需要 `initialize` 握手**，直接 `tools/call` 即可（已实测）。
- **响应是 SSE**：`event: message\ndata: <JSON>`。必须取 `data:` 行解析。
- 工具结果在 `result.content[0].text`，**这通常又是一段 JSON 字符串，要再 parse 一次**。

最小可用 Python 客户端（生产级完整版见 wire 文档 §5.1）：

```python
import requests, json

BASE = "https://kos.chenge.ink"

def mint_token(cid, csec):
    r = requests.post(f"{BASE}/token", data={
        "grant_type": "client_credentials", "client_id": cid, "client_secret": csec,
    }); r.raise_for_status()
    j = r.json(); return j["access_token"], j["expires_in"]   # 3600

def mcp_call(token, name, arguments):
    r = requests.post(f"{BASE}/mcp",
        headers={"Authorization": f"Bearer {token}",
                 "Content-Type": "application/json",
                 "Accept": "application/json, text/event-stream"},
        json={"jsonrpc":"2.0","id":1,"method":"tools/call",
              "params":{"name":name,"arguments":arguments}})
    r.raise_for_status()
    # SSE: 收集 data: 行，取最后一条完整 JSON-RPC 消息
    payload = None
    for line in r.text.splitlines():
        if line.startswith("data: "):
            try: payload = json.loads(line[6:])
            except json.JSONDecodeError: pass
    if payload is None: raise RuntimeError(f"no SSE data: {r.text[:200]}")
    if "error" in payload: raise RuntimeError(f"MCP error: {payload['error']}")
    text = payload["result"]["content"][0]["text"]
    try: return json.loads(text)        # 多数工具返回 JSON 字符串
    except json.JSONDecodeError: return text

tok, _ = mint_token(CID, CSEC)
hits = mcp_call(tok, "query", {"query": "Latigo", "source_id": "mailagent-emails", "limit": 5})
```

---

## 4. Source-scope 模型（第一大概念坑，务必内化）

`federated_read` **每次请求都从服务端实时判定**（不写进 token）。所以：

| 调用形态 | 行为 |
|---|---|
| 读操作**不带** `source_id` | 在**全部授权源**联邦检索：`default + mailagent-emails + omada` |
| 读操作**带** `source_id` 且在授权内 | 限定到该源 |
| 读操作**带** `source_id` 且**不在**授权内 | `permission_denied`（不是空结果，是显式报错） |
| 写操作（`put_page` 等） | 一律写到 client 的**写源**（consumer = `default`），写是单源隔离的 |

**推论 / 用法**：
- 改授权（加/减源）**立即生效**，无需重新 mint token。
- chat 想"全局问"就别传 source_id；想"只翻邮件"就传 `source_id:"mailagent-emails"`。
- **自检授权**：没有专门接口列你的 `federated_read`（`whoami` 只返回身份+OAuth scope，不返回源授权）。要确认就实查：query `source_id:"omada"` 应有结果，query `source_id:"gbrain-docs"` 应 `permission_denied`。

---

## 5. 给 chat LLM 暴露哪些工具

KOS 暴露了 60+ 工具。**给 chat 的 tool 集要精选**，不要把全部塞给 LLM。

**建议暴露（只读）**：
- **`query`** —— 主力。混合检索（向量+关键词+多查询扩展），带引用。**中文/语义问题用它。**
- `get_page` —— 按 slug 取整页。
- `list_pages` —— "最近/这周"类列举（按 `updated_at`）。
- `resolve_slugs` —— 模糊 slug → 命中 slug。
- `get_backlinks` / `traverse_graph` / `get_timeline` —— 关系/时间线追问。
- `whoami` —— 自检身份。

**可选（写，做 chat-save 才开）**：
- `put_page` —— 把对话/结论沉淀回 `default`。参数：`slug` / `content`（带 frontmatter 的 markdown）/ `source_uri` / `source_kind` / `ingested_via`。**没有 source_id（绑定写源）、没有 embedding 字段（服务端自己 embed，永远不要传向量）。**

**不要暴露给 chat**：`delete_page` / `sources_remove` / `submit_job`/`*_job` / `submit_agent` / `put_raw_data` / `revert_version` 等管理/破坏性/后台队列工具 —— chat LLM 用不到且有风险。

**`query` 常用参数速查**：

| 参数 | 说明 |
|---|---|
| `query` | 查询词（必填） |
| `source_id` | 限定单源；省略=联邦检索全部授权源 |
| `limit` | 条数（默认 20） |
| `detail` | `low`(仅 compiled truth) / `medium`(默认) / `high`(全 chunk) |
| `adaptive_return` | `true`=按意图返回精简结果集（"X 是谁/什么"这类单点查询用，省 token）；省略=全 top-K |
| `since` / `until` | 按 effective_date 过滤（`YYYY-MM-DD` 或 `7d`/`2w`/`1y`） |

---

## 6. Skills over MCP（`list_skills` / `get_skill`）—— 怎么用

KOS 发布了 **59 个 skill**（`mcp.publish_skills=true`）。**skill 不是可执行端点，而是一段"prose 操作手册"** —— 让 LLM 读懂"该怎么用这些工具完成某类任务"，然后它自己去调 §5 那些 CRUD 工具。

**标准用法（推荐做成一个 meta-flow）**：
1. `list_skills` → 拿到 `{name, description, triggers, tools[], writes_pages, mutating}` 列表。
2. LLM 按用户意图（或 `triggers`）选一个 skill。
3. `get_skill {name}` → 拿到 `{name, frontmatter, body}`，**把 `body`（prose）喂给 LLM**。
4. LLM 照 `body` 指示，调用其中列出的 `tools` 完成任务。

**catalog 是全局的**（所有 OAuth client 共享同一份，没有按 client 的白名单），所以**curation 要在你们这一侧做**（system prompt 里限定 / 只把相关 skill 喂给 LLM）：

- ✅ **适合 MailAgent chat 的**：`query`（读+综合+引用）、`idea-ingest`（存链接/文章）、`media-ingest`（音视频/书）、`meeting-ingestion`（会议纪要）、`brain-ops`（读→增强→写回循环）、`enrich`（补全实体）。
- ⛔ **不要喂给 chat 的**：`kos-jarvis/*` 全部是**运维/批处理 operator skill**（`corpus-ingest` / `corpus-synth` / `enrich-sweep` / `synthesis-sweep` / `dream-wrap` / `kos-patrol` / `orphan-reducer` …），是 KOS 侧定时任务用的，chat 用不到也不该碰。

> 取舍：如果你们的 chat 只做"问知识"，其实可以**不接 skill 层**，直接暴露 §5 的 `query`/`get_page` 等工具给 LLM 就够了。skill 层是当你们想让 LLM 处理更复杂的"按手册多步操作"（如规范化 ingest 一篇文章）时才有价值。

---

## 7. 误区清单（逐条对照排查）

1. **把 401 当成"查不到"** —— 401 = token 过期/打错 client，重新 mint。先验证 token 再谈结果。
2. **不带 `source_id` 却期望看到原始邮件** —— 联邦检索会让 `default` 的合成页排在前面；要邮件就 `source_id:"mailagent-emails"`。
3. **以为改授权要重发 token** —— 不用，`federated_read` 实时生效；token 只在过期时重发。
4. **SSE 没解析** —— 响应是 `event: message\ndata:{…}`，且 `result.content[0].text` 还要再 parse 一次。
5. **`put_page` 传向量/传 source_id** —— 都不需要；服务端按写源 embed。客户端无法也不应预计算 embedding。
6. **拿 bulk client 做 chat 检索** —— 它读不到 `default`/`omada`，别用。
7. **中文复合词用 `search`（关键词）** —— Postgres tsvector 不能 tokenize 4+ 连续汉字，关键词路径会漏。**中文一律用 `query`（含向量路径）。** 这对邮件中文语料尤其关键。
8. **`whoami` 找不到源授权** —— 它只返回 `{transport, client_id, client_name, scopes, expires_at}`；源授权用实查确认（§4）。

---

## 8. 验收脚本（直接 copy 跑，全绿即接通）

```bash
BASE=https://kos.chenge.ink
CID="$KOS_OAUTH_CLIENT_ID"; CSEC="$KOS_OAUTH_CLIENT_SECRET"
TOK=$(curl -s -X POST $BASE/token -d grant_type=client_credentials \
       -d client_id="$CID" -d client_secret="$CSEC" | jq -r .access_token)
H=(-H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
   -H 'Accept: application/json, text/event-stream')
sse(){ sed -n 's/^data: //p'; }

# 1) 身份
curl -s -X POST $BASE/mcp "${H[@]}" -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"whoami","arguments":{}}}' | sse | jq '.result.content[0].text|fromjson'
# 2) 邮件源命中（期望非空）
curl -s -X POST $BASE/mcp "${H[@]}" -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"query","arguments":{"query":"Latigo","source_id":"mailagent-emails","limit":3}}}' | sse | jq '.result.content[0].text'
# 3) 越权源（期望 permission_denied）
curl -s -X POST $BASE/mcp "${H[@]}" -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"query","arguments":{"query":"x","source_id":"gbrain-docs","limit":1}}}' | sse | jq '.result.content[0].text'
```

---

## 9. 需要改授权 / 出问题找谁

- 加/减 consumer 的可读源、新增 client、轮换 secret：找 **Lucien（KOS 侧）**，改 `oauth_clients.federated_read` 即时生效。
- 如果**用新 token 仍拿到 0**：把请求的完整 headers + 原始返回体发来，大概率是客户端缓存了过期 token、打到了别的 endpoint，或 SSE 没解析对。
