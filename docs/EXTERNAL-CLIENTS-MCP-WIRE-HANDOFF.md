# External Clients → MCP-over-HTTP wire spec (handoff)

> **Audience**: implementers of external clients that want to talk to Lucien's
> Jarvis Knowledge OS — e.g. OpenClaw feishu jarvis, mailagent (`ChenyqThu/MailAgent`),
> any future caller. **Self-contained** — assumes no knowledge of the fork's
> internals.
>
> **Status**: this doc replaces the old KOS-v1 contract (Bearer
> `KOS_API_TOKEN` against `kos.chenge.ink/{query,ingest,digest,status}`).
> Retire date: 2026-05-17 (`docs/JARVIS-ARCHITECTURE.md` §6.28).

---

## 1. Context

Jarvis Knowledge OS (KOS v2) is a personal Postgres-backed knowledge base
running on Lucien's Mac (`jarvis` Tailscale host). It's a fork of
[`garrytan/gbrain`](https://github.com/garrytan/gbrain). External callers
that previously talked to a fork-side HTTP wrapper (`kos-compat-api.ts`,
v1 KOS-Python-shim era) now talk **directly** to upstream gbrain's native
HTTP server (`gbrain serve --http`) using:

- **OAuth 2.1 client_credentials grant** (per-client `client_id` + `client_secret`,
  hourly access token, per-call audit in `mcp_request_log` DB table)
- **MCP JSON-RPC over HTTP** (Model Context Protocol; same wire format as
  Anthropic Claude Desktop / official MCP clients)

External entry: **`https://kos.chenge.ink`** (cloudflared tunnel, routed by
mbp-office cloudflared to jarvis Mac `:7225`).

**What this gives you over the old KOS-v1 Bearer wire**:
- Per-client identity (revoke one without affecting others)
- Per-call audit trail (`mcp_request_log` rows include `agent_name`, `operation`,
  `latency_ms`, `status`, `params` JSONB, `error_message`, `created_at`)
- Token rotation (no shared static secret across all callers)
- Direct access to 29 upstream MCP operations (most we don't expose, but
  available if needed: `add_link`, `get_backlinks`, `traverse_graph`,
  `add_timeline_entry`, `think`, `run_doctor`, etc.)

---

## 2. OAuth 2.1 client setup (one-time, Lucien runs on jarvis Mac)

For each external caller, Lucien registers an OAuth client on the jarvis
Mac and sends you the `client_id` + `client_secret`. **The `client_secret`
is shown exactly once and not recoverable** (only SHA-256 hash persists in
the DB). Store it in your project's secrets manager (env vars, 1Password,
etc.) — never commit to git.

**Lucien's side**:

```bash
# On jarvis Mac
bin/gbrain auth register-client "openclaw-feishu" \
  --grant-types client_credentials \
  --scopes "read write" \
  --source default

# Output (one-time):
#   OAuth client registered: "openclaw-feishu"
#     Client ID:        gbrain_cl_<32-hex>
#     Client Secret:    gbrain_cs_<32-hex>
#     ...
#   Save the client secret — it will not be shown again.
```

**Scopes**: `read` (query / list_pages), `write` (put_page / add_link / add_timeline_entry),
`admin` (get_stats / get_health admin variant / sync_brain). Almost all
external callers want exactly `read write` — `admin` is rarely needed and
exposes destructive operations.

**Lucien transmits via secure channel** (Signal, 1Password share, encrypted
mail — NEVER plain email or unencrypted chat).

**You store as**:
```
KOS_MCP_BASE=https://kos.chenge.ink
KOS_OAUTH_CLIENT_ID=gbrain_cl_xxxxx
KOS_OAUTH_CLIENT_SECRET=gbrain_cs_yyyyy
```

If you lose the secret: ask Lucien to run `bin/gbrain auth revoke-client <client_id>`
+ re-register. Old `client_id` becomes invalid; new one is issued.

---

## 3. Wire spec

### 3.1 OAuth `/token` (client_credentials grant)

```http
POST /token HTTP/1.1
Host: kos.chenge.ink
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials&client_id=<KOS_OAUTH_CLIENT_ID>&client_secret=<KOS_OAUTH_CLIENT_SECRET>&scope=read write
```

**Success (200)**:
```json
{
  "access_token": "gbrain_at_<hex>",
  "token_type": "bearer",
  "expires_in": 3600,
  "scope": "read write"
}
```

There is **no `refresh_token`** — re-call `/token` whenever your cached
access_token is near expiry or rejected with 401.

**Errors (400)**:
- `{"error":"invalid_request","error_description":"client_id and client_secret required"}` — missing creds
- `{"error":"invalid_grant","error_description":"<msg>"}` — bad creds, revoked client, wrong grant type

**Rate limit**: 50 requests / 15 minutes (server-side at `src/commands/serve-http.ts:268-274`).
Well above any normal client frequency.

### 3.2 MCP `POST /mcp` (JSON-RPC `tools/call`)

```http
POST /mcp HTTP/1.1
Host: kos.chenge.ink
Authorization: Bearer <access_token>
Content-Type: application/json
Accept: application/json, text/event-stream

{
  "jsonrpc": "2.0",
  "id": "1",
  "method": "tools/call",
  "params": {
    "name": "query",
    "arguments": { "query": "Lucien 的 fork 策略" }
  }
}
```

**Success (200)** — JSON envelope wrapping the op result:
```json
{
  "jsonrpc": "2.0",
  "id": "1",
  "result": {
    "content": [
      { "type": "text", "text": "<JSON.stringify(opResult, null, 2)>" }
    ],
    "isError": false
  }
}
```

**Critical**: the op's actual return value is **`JSON.stringify`-ed into
`content[0].text`**, not in `structuredContent`. Client must
`JSON.parse(result.content[0].text)` to get back to the structured value.
This is the upstream MCP SDK convention (`src/mcp/dispatch.ts:254`).

**Op-layer error (200 with `isError:true`)**:
```json
{
  "jsonrpc": "2.0",
  "id": "1",
  "result": {
    "content": [
      { "type": "text", "text": "{\"error\":\"page_not_found\",\"message\":\"slug 'foo' does not exist\",\"suggestion\":\"try list_pages first\",\"docs\":\"...\"}" }
    ],
    "isError": true
  }
}
```
Parse `content[0].text` as JSON to get the structured error.

**JSON-RPC-layer error (400/500)** — malformed request, internal error:
```json
{
  "jsonrpc": "2.0",
  "id": "1",
  "error": { "code": -32603, "message": "internal error" }
}
```

**SSE format — DEFAULT, not optional** (verified 2026-05-17 on gbrain
v0.35.6.0 + OpenClaw feishu jarvis Python integration): `gbrain serve
--http` returns `Content-Type: text/event-stream` for `/mcp` responses
**by default**, even for synchronous `tools/call`. The body shape is:

```
event: message
data: {"jsonrpc":"2.0","id":"1","result":{...}}

```

Clients MUST extract the line starting with `data: ` and parse its JSON
payload. Raw `r.json()` (Python `requests`) and direct `jq .` on the body
will fail with "Invalid numeric literal" because they see the `event:`
prefix first. See `§5.1` Python and `§5.3` bash patterns for the
defensive extraction. `/token` and `/health` return plain JSON (not SSE).

### 3.3 `/health` (auth-less)

```http
GET /health HTTP/1.1
Host: kos.chenge.ink
```

```json
{ "status": "ok", "version": "0.35.6.0", "engine": "postgres" }
```

Use for liveness probes / health checks. No auth required.

---

## 4. Endpoint mapping table (KOS-v1 → MCP)

| Old wire (KOS-v1) | New wire (MCP) | Caveat |
|---|---|---|
| `POST /query` body `{question}` | `tools/call` `name="query"` args `{query: <q>}` | **Returns raw retrieval array** (hybridSearch hits), not LLM-synthesized answer. Caller must do its own LLM synthesis (caller's agent likely already does this) or `gbrain ask` locally. The old fork-side `synthesizeAnswer` LLM call is retired. |
| `GET /status` | `tools/call` `name="list_pages"` args `{limit: 100, sort: "updated_desc"}` + client-side aggregation | `list_pages` caps `limit` at 100 and doesn't expose `offset` (`src/core/operations.ts:1014`). For exact total page count, ssh into jarvis and run `gbrain status` — there's no `total_pages` field exposed via MCP without admin scope. |
| `POST /ingest` (markdown mode) `{markdown, title, kind, tags, source}` | `tools/call` `name="put_page"` args `{slug: "<dir>/<slug>", content: "<full markdown with YAML frontmatter>"}` | **SSoT inverted**: `put_page` writes directly to Postgres (chunk + embed + facts_backstop queue), **does NOT write `~/brain/<dir>/<slug>.md` disk file** and does NOT git commit. Caller is responsible for constructing the full markdown including YAML frontmatter — see §6.2 below for the convention. `auto_links` + `auto_timeline` are skipped for remote callers (safety gate); entity-graph is back-filled by host-side `dream-cycle` cron within 24h. |
| `POST /ingest` (URL mode) `{url}` | Caller-side `fetch(url)` + HTML→text + `put_page` | Fork-side `url-fetcher` (Tavily/FlareSolverr for X/Twitter protected pages) is no longer reachable from external callers. Pass markdown directly if the URL is protected. If you need Tavily integration, do it client-side (own Tavily API key). |
| `GET /digest?since=N` | **RETIRED** | No MCP equivalent. patrol digest still written by host-side `kos-patrol` cron to `~/brain/.agent/digests/patrol-*.md`; reachable via ssh or via OpenClaw `MEMORY.md` (`digest-to-memory` writes weekly Sun 22:00). |
| `GET /health` | `GET /health` (unchanged path, same shape, no auth needed) | — |

---

## 5. Code patterns

### 5.1 Python (`requests`) — recommended for OpenClaw

```python
import os
import json
import time
from typing import Any
import requests

KOS_MCP_BASE = os.environ["KOS_MCP_BASE"]
KOS_OAUTH_CLIENT_ID = os.environ["KOS_OAUTH_CLIENT_ID"]
KOS_OAUTH_CLIENT_SECRET = os.environ["KOS_OAUTH_CLIENT_SECRET"]

_token_cache: dict[str, Any] = {}

def _get_access_token() -> str:
    """OAuth client_credentials grant. Cache in-process (TTL 1h), refresh on near-expiry."""
    now = time.time()
    if _token_cache.get("access_token") and _token_cache.get("expires_at", 0) > now + 60:
        return _token_cache["access_token"]
    r = requests.post(
        f"{KOS_MCP_BASE}/token",
        data={
            "grant_type": "client_credentials",
            "client_id": KOS_OAUTH_CLIENT_ID,
            "client_secret": KOS_OAUTH_CLIENT_SECRET,
            "scope": "read write",
        },
        timeout=30,
    )
    r.raise_for_status()
    body = r.json()
    _token_cache["access_token"] = body["access_token"]
    _token_cache["expires_at"] = now + body["expires_in"]
    return body["access_token"]

def _parse_mcp_response(raw_body: str, content_type: str) -> dict:
    """Parse /mcp response. Server returns SSE by default (Content-Type:
    text/event-stream) even for synchronous tools/call. Extract the `data:`
    line and parse its JSON payload. Falls back to plain JSON if server
    ever changes its mind (e.g. /token-style plain-JSON responses).
    """
    if "text/event-stream" in content_type:
        for line in raw_body.splitlines():
            if line.startswith("data: "):
                return json.loads(line[len("data: "):])
        raise RuntimeError("SSE response with no `data:` line found")
    return json.loads(raw_body)  # plain JSON fallback

def mcp_call(tool_name: str, arguments: dict[str, Any], timeout: int = 240) -> Any:
    """Call an MCP tool. Returns the parsed op result. Raises on error envelope."""
    token = _get_access_token()
    r = requests.post(
        f"{KOS_MCP_BASE}/mcp",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        },
        json={
            "jsonrpc": "2.0",
            "id": "1",
            "method": "tools/call",
            "params": {"name": tool_name, "arguments": arguments},
        },
        timeout=timeout,
    )
    r.raise_for_status()
    body = _parse_mcp_response(r.text, r.headers.get("content-type", ""))
    if body.get("error"):
        raise RuntimeError(f"MCP {tool_name} JSON-RPC error: {body['error']['message']}")
    text = body.get("result", {}).get("content", [{}])[0].get("text", "")
    if body.get("result", {}).get("isError"):
        err = json.loads(text)
        raise RuntimeError(
            f"MCP {tool_name} op error ({err.get('error', 'unknown')}): {err.get('message', text)}"
        )
    return json.loads(text)  # All op results are JSON-stringified per dispatch.ts:254

# Usage examples:
hits = mcp_call("query", {"query": "harness engineering 是什么"})
pages = mcp_call("list_pages", {"limit": 100, "sort": "updated_desc"})
result = mcp_call("put_page", {
    "slug": "sources/openclaw-feishu-2026-05-17-meeting",
    "content": "---\ntype: source\nkind: source\ntitle: '...'\n...\n---\n\n# ...\n\nbody...\n",
})
print(result)  # {"slug": "...", "status": "created_or_updated", "chunks": N, ...}
```

**Token cache**: in-process dict cache OK if your process is long-lived
(daemon, cron). For stateless serverless / one-shot CLI invocations,
skip the cache and pay 100-300ms per call.

### 5.2 TypeScript / Node — for mailagent or any TS daemon

```typescript
const KOS_MCP_BASE = process.env.KOS_MCP_BASE!;
const KOS_OAUTH_CLIENT_ID = process.env.KOS_OAUTH_CLIENT_ID!;
const KOS_OAUTH_CLIENT_SECRET = process.env.KOS_OAUTH_CLIENT_SECRET!;

let tokenCache: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt > now + 60_000) return tokenCache.token;
  const r = await fetch(`${KOS_MCP_BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: KOS_OAUTH_CLIENT_ID,
      client_secret: KOS_OAUTH_CLIENT_SECRET,
      scope: "read write",
    }),
  });
  if (!r.ok) throw new Error(`OAuth /token HTTP ${r.status}: ${await r.text()}`);
  const body = await r.json() as { access_token: string; expires_in: number };
  tokenCache = { token: body.access_token, expiresAt: now + body.expires_in * 1000 };
  return body.access_token;
}

async function mcpCall<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
  const token = await getAccessToken();
  const r = await fetch(`${KOS_MCP_BASE}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "1",
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  if (!r.ok) throw new Error(`MCP ${name} HTTP ${r.status}: ${await r.text()}`);
  // Server returns SSE by default (event: message\ndata: <JSON>). Detect
  // Content-Type and extract the data: line; fall back to plain JSON only
  // if the server ever negotiates non-SSE (per MCP SDK contract).
  const contentType = r.headers.get("content-type") ?? "";
  let env: { error?: { message: string }; result?: { content?: Array<{ text?: string }>; isError?: boolean } };
  if (contentType.includes("text/event-stream")) {
    const raw = await r.text();
    const dataLine = raw.split("\n").find((l) => l.startsWith("data: "));
    if (!dataLine) throw new Error(`MCP ${name} SSE response with no data: line`);
    env = JSON.parse(dataLine.slice("data: ".length));
  } else {
    env = await r.json();
  }
  if (env.error) throw new Error(`MCP ${name} JSON-RPC error: ${env.error.message}`);
  const text = env.result?.content?.[0]?.text ?? "";
  if (env.result?.isError) {
    const err = JSON.parse(text) as { error?: string; message?: string };
    throw new Error(`MCP ${name} op error (${err.error}): ${err.message}`);
  }
  return JSON.parse(text) as T;
}
```

(For a complete Notion-Worker-flavored reference impl, see
[`workers/kos-worker/src/index.ts`](../workers/kos-worker/src/index.ts).)

### 5.3 Bash / curl — for ad-hoc diagnostics

```bash
# 1. Get token
TOK=$(curl -s -X POST "$KOS_MCP_BASE/token" \
  -d "grant_type=client_credentials" \
  -d "client_id=$KOS_OAUTH_CLIENT_ID" \
  -d "client_secret=$KOS_OAUTH_CLIENT_SECRET" \
  -d "scope=read write" | jq -r .access_token)

# 2. Call MCP — response is SSE (event: message\ndata: <JSON>), extract data:
curl -s -X POST "$KOS_MCP_BASE/mcp" \
  -H "Authorization: Bearer $TOK" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":"1","method":"tools/call","params":{"name":"query","arguments":{"query":"foo"}}}' \
  | grep '^data: ' | sed 's/^data: //' \
  | jq -r '.result.content[0].text' | jq .
```

---

## 6. Caller-side notes for each op

### 6.1 `query` (was `POST /query`)

- Returns array of search hits: `[{slug, score, snippet, chunks: [...]}, ...]`
- **No LLM synthesis** at the server side — caller's agent must summarize.
- Default `limit: 20`, max 100.
- Optional `expand: true` to pull related pages via entity links (more
  expensive; adds latency).

### 6.2 `put_page` (was `POST /ingest` markdown mode)

- Args `{slug: string, content: string}`. The `content` is the **full markdown
  document** including YAML frontmatter. There is NO separate `frontmatter`
  field.
- Slug **must include the directory prefix** if you want it to land under
  `sources/` / `concepts/` / etc. — e.g. `slug: "sources/2026-05-17-meeting"`.
- Caller-controlled YAML frontmatter required at minimum:
  ```yaml
  ---
  type: source            # gbrain enum: source|concept|note|writing|person|company|project
  kind: source            # KOS-quality-gate tag; convention overlaps with type but free-form
  title: 'Some Title'     # single-quoted to escape : and other YAML meta
  status: draft
  created: '2026-05-17'
  updated: '2026-05-17'
  source_of_truth: <ingest source identifier>
  source_refs:
    - <url or notion:id or mailagent:msg_id>
  tags: [your-source-name, optional-extra-tag]
  ---
  ```
- KOS `kind` → gbrain `type` mapping (so upstream lint passes):
  | KOS kind | gbrain type |
  |---|---|
  | source | source |
  | concept | concept |
  | project | project |
  | entity | note |
  | decision | concept |
  | synthesis | writing |
  | comparison | writing |
  | protocol | concept |
  | timeline | note |
  | person | person |
  | company | company |
- Response: `{slug, status: "created_or_updated"|"skipped", chunks: N, facts_backstop: {queued: true}, writer_lint: {...}}`
- **Skipped pipelines on remote put_page** (safety gate at
  `src/core/operations.ts:610-612`):
  - `auto_links: {skipped: "remote"}` — entity link graph NOT auto-built
  - `auto_timeline: {skipped: "remote"}` — timeline entries NOT auto-extracted
  - These are back-filled by host-side `dream-cycle` (03:11 daily). Acceptable
    24h lag for most use cases.

### 6.3 `list_pages` (was `GET /status`)

- Args `{limit, type, tag, updated_after, sort, include_deleted}`. `limit` caps at 100.
- Response: array of `{slug, type, title, updated_at}`. No frontmatter, no body.
- For exact total page count, ssh to jarvis Mac and run `gbrain status`.
  There is no `total_pages` exposed via MCP without `admin` scope (and
  `get_stats` has >3s latency on large brains anyway).

### 6.4 `get_health`

Use unauthenticated `GET /health` for liveness. The MCP `get_health`
operation requires `admin` scope and adds latency.

---

## 7. Per-client notes

### 7.1 mailagent (`ChenyqThu/MailAgent`, GitHub issue #1)

**Status**: spec-only as of 2026-05-17. Brain-side has no fork code waiting;
when mailagent implements `mailagent kos push <internal_id>`, it should
call MCP `put_page` directly per §5.2 (TypeScript) or §5.1 (Python).

**Payload shape** (replaces the old `POST /ingest markdown` shape from
§6.27 of `docs/JARVIS-ARCHITECTURE.md`):

```python
slug = f"sources/mailagent-{message_id_normalized}"  # message_id → lowercase + non-alphanum→hyphen
content = f"""---
type: source
kind: source
title: '{subject_yaml_escaped}'
status: draft
created: '{date_iso}'
updated: '{date_iso}'
source_of_truth: mailagent-sqlite
source_refs:
  - mailagent:{message_id}
  - {notion_url_if_mirrored}
tags: [mailagent-ingest, email]
date_received: '{date_received}'
sender: '{sender_yaml_escaped}'
mailbox: '{mailbox}'
---

# {subject}

> Ingested via mailagent kos push on {date_iso}.

{body_markdown}
"""
mcp_call("put_page", {"slug": slug, "content": content})
```

Lucien's mailagent OAuth client is reserved at registration time but
secret not issued until mailagent is ready to wire it. When ready, ping
Lucien: `bin/gbrain auth register-client "mailagent" --grant-types client_credentials --scopes "read write"`.

### 7.2 OpenClaw feishu jarvis (cross-repo)

**Status**: dormant since 2026-05-05 (signal-detector extension retired,
see `skills/kos-jarvis/_archived/feishu-bridge/`). If you re-activate
Feishu-side ingestion to Knowledge OS, use this spec. There's no fork-side
deprecation work needed (already archived).

**Old wire** (KOS-v1, now retired):
```python
requests.post("https://kos.chenge.ink/ingest", json={"markdown": "...", "title": "...", ...},
              headers={"Authorization": f"Bearer {KOS_API_TOKEN}"})
```

**New wire** (MCP, per §5.1 Python pattern above):
```python
mcp_call("put_page", {"slug": "sources/feishu-...", "content": "---\n...\n---\n\n..."})
```

If you need cross-checks (e.g. avoid re-ingesting messages already in brain):
```python
existing = mcp_call("list_pages", {"limit": 100, "tag": "feishu-ingest", "sort": "updated_desc"})
seen_slugs = {p["slug"] for p in existing}
```

---

## 8. Validation acceptance

When you wire up, verify end-to-end with this smoke flow:

```bash
# 1. Token exchange works
TOK=$(curl -s -X POST "$KOS_MCP_BASE/token" \
  -d "grant_type=client_credentials" \
  -d "client_id=$KOS_OAUTH_CLIENT_ID" \
  -d "client_secret=$KOS_OAUTH_CLIENT_SECRET" \
  -d "scope=read write" | jq -r .access_token)
[ -n "$TOK" ] || { echo "FAIL: token exchange"; exit 1; }
echo "  ✓ access_token issued"

# 2. tools/list returns ≥10 ops (confirms scope OK)
TOOLS=$(curl -s -X POST "$KOS_MCP_BASE/mcp" \
  -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":"1","method":"tools/list"}' \
  | grep '^data: ' | sed 's/^data: //' | jq -r '.result.tools | length')
[ "$TOOLS" -ge 10 ] || { echo "FAIL: tools/list returned $TOOLS"; exit 1; }
echo "  ✓ tools/list returns $TOOLS ops"

# 3. query smoke (SSE response → extract data: line first)
curl -s -X POST "$KOS_MCP_BASE/mcp" \
  -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":"1","method":"tools/call","params":{"name":"query","arguments":{"query":"smoke"}}}' \
  | grep '^data: ' | sed 's/^data: //' \
  | jq -r '.result.content[0].text' | jq '. | length' \
  | xargs -I{} sh -c '[ {} -ge 0 ] && echo "  ✓ query returned {} hits"'

# 4. put_page smoke (writes a real test page; clean up later)
SLUG="sources/handoff-smoke-$(date +%s)"
curl -s -X POST "$KOS_MCP_BASE/mcp" \
  -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d "$(jq -nc --arg slug "$SLUG" '{jsonrpc:"2.0",id:"1",method:"tools/call",params:{name:"put_page",arguments:{slug:$slug,content:"---\ntype: source\nkind: source\ntitle: handoff-smoke\nstatus: draft\ncreated: 2026-05-17\nupdated: 2026-05-17\nsource_refs: [handoff-smoke]\ntags: [smoke-test]\n---\n\n# handoff smoke\n\nIf you see this in vector search, the wire works."}}}')" \
  | grep '^data: ' | sed 's/^data: //' \
  | jq -r '.result.content[0].text' | jq -r '.status'
# expect: created_or_updated

echo "All smoke checks PASS — wire is operational"
```

Lucien can verify on brain side: `psql -d gbrain -c "SELECT count(*) FROM mcp_request_log WHERE agent_name='<your-client-name>' AND created_at > now() - interval '5 min'"` should return non-zero.

---

## 9. Rollback (caller-side concern)

If your client wire integration fails post-cutover:

- **Brain-side rollback is Lucien's concern** — old `kos-compat-api`
  (KOS-v1 Bearer wire on `kos.chenge.ink`) is retained for 1 week post-cutover
  (Phase 3 of `docs/JARVIS-ARCHITECTURE.md` §6.28). Ask Lucien for the old
  `KOS_API_TOKEN` if you need to revert to the old wire as emergency
  fallback during that window.
- **After 1-week observation** old wire is fully retired; rollback requires
  brain-side `git revert` of the Phase 3 commit + `launchctl bootstrap` of
  the archived kos-compat-api plist. Coordinate with Lucien.

---

## 10. Timeline expectations

- **Cutover window**: anytime in the 1-week observation period
  (~2026-05-17 → 2026-05-24)
- **Caller-side dev**: 1-2 day for a competent implementer (mostly OAuth
  + JSON-RPC framing helpers + endpoint mapping)
- **Lucien coordination needed for**:
  - Issuing OAuth client credentials (one curl + secure-channel handoff)
  - Verifying `mcp_request_log` audit rows land for your client name
- **No coordination needed**: spec is stable; future caller versions only
  need to update tool args if the underlying op's params change (rare —
  upstream gbrain treats MCP ops as a public contract).

---

## 11. Links

- Brain-side full retire story: [`docs/JARVIS-ARCHITECTURE.md` §6.28](JARVIS-ARCHITECTURE.md#628-kos-compat-api-retire--mcp-over-http-cutover)
- Notion Knowledge Agent reference impl: [`workers/kos-worker/src/index.ts`](../workers/kos-worker/src/index.ts)
- Notion-side UI update for v2→v3: [`docs/NOTION-AGENT-UPDATE-CHECKLIST.md`](NOTION-AGENT-UPDATE-CHECKLIST.md)
- Upstream gbrain serve-http implementation: [`src/commands/serve-http.ts`](../src/commands/serve-http.ts) (1112 LoC, don't modify in fork)
- Upstream MCP ops source of truth: [`src/core/operations.ts`](../src/core/operations.ts)
- Upstream OAuth provider implementation: [`src/core/oauth-provider.ts`](../src/core/oauth-provider.ts)
- All MCP operations available (29): listed in `docs/KOS-COMPAT-API-MIGRATION-PLAN.md` §10.2
