# MailAgent → Jarvis KOS Brain — Ingest Handoff

> **Audience**: MailAgent's ClaudeCode (running on MacBook Pro, talking
> to Lucien's Jarvis brain via `kos.chenge.ink`). This doc is
> self-contained — you do NOT need to read the brain's repo to follow
> the contract here; everything you need to wire up is below.
>
> **Brain repo (reference only, not yours to touch)**:
> `ChenyqThu/jarvis-knowledge-os-v2`. The brain is a fork of
> `garrytan/gbrain`, with kos-jarvis extensions; it runs on Lucien's
> jarvis Mac, exposed at `https://kos.chenge.ink`.
>
> **Status**: handed off 2026-05-26 (post-§6.31 sync). Replaces the
> stale §7.1 of `EXTERNAL-CLIENTS-MCP-WIRE-HANDOFF.md` (which referenced
> a `sources/mailagent-{id}` slug shape from before namespace conventions
> were locked).

---

## 1. Context — what you're doing

You are MailAgent. You have two distinct ingest scenarios into Lucien's
brain. **Do not confuse them — they use different slugs, different
sources, and different frontmatter shapes.**

| Scenario | When it fires | Where it lands | Volume |
|---|---|---|---|
| **A. Curated chat-save** | User clicks ✨保存到 KOS in chat panel | `default` source, slug `chat-history/mailagent/...` | low (user-selected, ~10s/day) |
| **B. Bulk email ingest** | One-time history sync + nightly incremental | **`mailagent-emails` source** (new), slug `sources/email/<id>` | high (initial: thousands; daily: dozens) |

Scenario A is already implemented (Sprint 19 P1-C). Just verify it
matches §3 below (you may need to switch your existing `conversations/`
or `sources/mailagent-{id}` prefix to the new one). Scenario B is new
work you're picking up now.

---

## 2. Wire setup (one-time)

### 2.1 OAuth credentials — **TWO clients, one per scenario**

⚠ **Important**: `put_page` does NOT accept a `source` / `source_id`
argument. Source routing is decided **by the OAuth client's
`source_id` binding** (set when Lucien registers the client). So
writing to two different sources requires two different OAuth clients.

You need TWO sets of credentials from Lucien (each via Signal /
1Password, NEVER plain email):

```
# Scenario A — curated chat-save (writes to default source)
MAILAGENT_CHAT_CLIENT_ID=gbrain_cl_<32-hex>
MAILAGENT_CHAT_CLIENT_SECRET=gbrain_cs_<32-hex>

# Scenario B — bulk email ingest (writes to mailagent-emails source)
MAILAGENT_BULK_CLIENT_ID=gbrain_cl_<32-hex>
MAILAGENT_BULK_CLIENT_SECRET=gbrain_cs_<32-hex>

KOS_MCP_BASE=https://kos.chenge.ink
```

The two clients are registered Lucien-side as:
- `mailagent` — `--source default` (binds writes to default source)
- `mailagent-bulk` — `--source mailagent-emails` (binds writes to the
  isolated bulk-email source)

Pick the right client per call. **If you use the wrong client, the
page silently lands in the wrong source — there is no validation
error** (the put returns `status: created_or_updated` regardless;
only `get_page` afterwards reveals the actual `source_id` field).

If credentials are lost / never received: Lucien runs `bin/gbrain
auth revoke-client <client_id>` then `register-client` to re-issue.

### 2.2 Token exchange (refresh on 401, cache ~1h)

```http
POST /token HTTP/1.1
Host: kos.chenge.ink
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials&client_id=<CID>&client_secret=<CSEC>&scope=read write
```

Response:
```json
{
  "access_token": "gbrain_at_<hex>",
  "token_type": "Bearer",
  "expires_in": 3600,
  "scope": "read write"
}
```

Use `Authorization: Bearer <access_token>` on every `/mcp` call. On 401,
re-exchange; tokens are TTL 1h.

### 2.3 MCP `/mcp` call shape (JSON-RPC over SSE)

```http
POST /mcp HTTP/1.1
Host: kos.chenge.ink
Authorization: Bearer <access_token>
Content-Type: application/json
Accept: application/json, text/event-stream

{
  "jsonrpc": "2.0",
  "id": "<your-request-id>",
  "method": "tools/call",
  "params": {
    "name": "<tool-name>",
    "arguments": { ...tool-specific-args... }
  }
}
```

Response is **SSE** (`text/event-stream`) — extract the `data:` line,
JSON-decode, and look at `.result.content[0].text` which contains the
tool's JSON-stringified payload (you'll need to JSON.parse it again).
Python `mcp_call` helper pattern: see §5.

### 2.4 Wait for source to exist (Scenario B only)

Before you can write to `mailagent-emails` source, **Lucien must run on
jarvis Mac**:

```bash
bin/gbrain sources add mailagent-emails \
  --local-path /Users/chenyuanquan/mailagent-emails/ \
  --description "MailAgent inbox bulk import + incremental"
```

Lucien pings you when this is done. Until then, your `put_page` calls
with `source: mailagent-emails` will 400. Test with `list_pages` first:

```python
result = mcp_call("list_pages", {"source_id": "mailagent-emails", "limit": 1})
# If result is {"error": "source not found"} or similar → wait for Lucien
# If result is {"pages": []} → source exists, ready to ingest
```

---

## 3. Scenario A — Curated chat-save (verify your existing impl)

This is the ✨保存到 KOS button. You already wired it in Sprint 19 P1-C
under a slug like `conversations/<email-id>-<session-id>-<message-id>`.
**Switch to the new convention below** (single `SLUG_PREFIX` constant
change in your code).

### Slug shape

```
chat-history/mailagent/<email-id>/<session-id>/<message-id>
```

Each segment is the raw identifier from your store (lowercase, alphanumeric
+ hyphens + underscores; no `/` or whitespace inside a segment).

### Frontmatter

```yaml
---
type: conversation
kind: source                            # GBrain MECE category for captured content
title: <derived from first user turn, ≤80 chars; LLM-summarize if longer>
status: stable                          # or "draft" if multi-turn, mid-save
created: 2026-05-26                     # YYYY-MM-DD
updated: 2026-05-26
tags: [chat-history, conversation, mailagent]
source: mailagent-chat                  # NOT a GBrain source_id; this is a logical tag
pinned: false                           # set true to exempt from 90d retention sweeps
mailagent:
  email_id: <id>
  session_id: <id>
  message_id: <id>
  # ... any other traceback IDs you want to round-trip
---
```

### Body shape

```markdown
## User

<user message verbatim>

## Assistant

<assistant response verbatim>
```

Multi-turn: alternate `## User` / `## Assistant` blocks. Don't include
the system prompt unless the user explicitly cared about it.

### Source routing for chat-save

Use the **`mailagent` OAuth client** (binds to default source).
`put_page` itself takes only `slug` + `content`:

```python
mcp_call_with_chat_client("put_page", {
    "slug": f"chat-history/mailagent/{email_id}/{session_id}/{message_id}",
    "content": <markdown with frontmatter above>,
})
```

The frontmatter `source: mailagent-chat` field is a **logical tag**
(searchable, useful for filtering by `tag:` later), NOT what routes
the page to a brain source. The actual brain source_id is decided by
the OAuth client. Use the right client.

---

## 4. Scenario B — Bulk email ingest (new)

This is the historical email sync + nightly incremental. Goes into the
**`mailagent-emails` source**, isolated from the main brain by source_id,
queryable by source filter, cleanable by source-scoped DELETE.

### Slug shape

```
sources/email/<email-id>
```

`<email-id>` = your stable internal ID for the email (whatever you use as
PK in your SQLite store; the brain doesn't care about format as long as
it's stable, URL-safe, and uniquely identifies one email).

### Frontmatter

```yaml
---
type: email                             # KOS page kind
kind: source                            # GBrain MECE
title: '<email subject, YAML-escaped, ≤200 chars>'
status: stable
created: '2026-04-15'                   # date email was sent/received (NOT today)
updated: '2026-04-15'
date_received: '2026-04-15T10:23:45+08:00'  # ISO 8601, full precision
sender: '<From: header, YAML-escaped>'
recipient: '<To: header, YAML-escaped>'
cc: ['<addr1>', '<addr2>']              # optional, omit if empty
mailbox: '<inbox / archive / promotions / etc.>'
labels: ['<label1>', '<label2>']        # gmail labels or your equivalent
thread_id: '<thread/conversation id>'   # if available; brain may use this for thread reconstruction
tags: [email, mailagent-ingest, bulk]
source: mailagent-emails                # logical tag, mirrors the GBrain source_id; required
source_of_truth: mailagent-sqlite       # tells brain where to round-trip for canonical version
source_refs:
  - mailagent:<email-id>                # back-pointer for round-trip
mailagent:
  email_id: <id>
  thread_id: <id>
  internal_path: <your internal storage path, optional>
---
```

### Body shape

```markdown
# {subject}

> Ingested via mailagent kos push on {date_iso}.
> From: {sender} → To: {recipient}{cc_line_if_any}
> Date: {date_received}
> Mailbox: {mailbox}{labels_line_if_any}

{body_markdown}

{if attachments:}
## Attachments

- {attachment_1_filename} ({size_mb} MB, {mime_type})
- {attachment_2_filename} ({size_mb} MB, {mime_type})
```

**Body content guidelines**:

- Plain-text bodies: pass through as-is, no escaping needed (markdown
  treats unmatched `*` / `_` etc. as literal in most cases).
- HTML bodies: convert to markdown first (e.g. `turndown` / `html-to-md`
  in Node). Don't ingest raw HTML — it pollutes vector embedding.
- Quote chains (`> previous reply`): keep them, they help context.
- Boilerplate footers (unsubscribe links, legal disclaimers): consider
  stripping with a regex; they add noise without semantic value.
- Length cap: if a single email body > 50 KB after markdown
  conversion, truncate to first 50 KB + a `> _(truncated; full body
  available at mailagent:<email-id>)_` marker. The brain rejects
  oversized pages anyway (per v0.40.10 content sanity defense).

### Source routing for bulk-email calls

Use the **`mailagent-bulk` OAuth client** (binds to `mailagent-emails`
source). `put_page` itself takes only `slug` + `content`:

```python
mcp_call_with_bulk_client("put_page", {
    "slug": f"sources/email/{email_id}",
    "content": <markdown with frontmatter above>,
})
```

⚠ **`source` / `source_id` arguments on `put_page` are silently
ignored.** The MCP put_page schema only accepts `slug` + `content` +
some server-stamped provenance fields (`source_kind` / `source_uri` /
`ingested_via` are server-stamped from remote, client values ignored).
Source routing is **OAuth-client-bound**, not per-call. If you use the
wrong client, the page silently lands in the wrong source.

The frontmatter `source: mailagent-emails` field is a **logical tag**,
NOT what routes the page. Both signals (OAuth client binding AND
frontmatter tag) should be consistent for sanity, but only the OAuth
client binding actually controls routing.

**Verification after smoke**: read back via `get_page` and check
`result.page.source_id === "mailagent-emails"`. If it's `"default"`
you used the wrong client.

---

## 5. Code patterns (TypeScript, since MailAgent is TS)

### 5.1 Token + MCP helper (factory; one instance per OAuth client)

Because Scenario A and Scenario B route to different brain sources via
different OAuth clients, instantiate the helper twice — one per client
— and call the right one per use case:

```typescript
// kos-client.ts — factory: each invocation returns a helper bound to
// one OAuth client (chat OR bulk). Cache tokens per instance.

interface KosClient {
  call: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
}

export function createKosClient(opts: {
  base: string;
  clientId: string;
  clientSecret: string;
}): KosClient {
  let cachedToken: { value: string; expiresAt: number } | null = null;

  async function getToken(): Promise<string> {
    if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
      return cachedToken.value;
    }
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      scope: 'read write',
    });
    const res = await fetch(`${opts.base}/token`, { method: 'POST', body });
    if (!res.ok) throw new Error(`token exchange ${res.status}: ${await res.text()}`);
    const j = await res.json();
    cachedToken = { value: j.access_token, expiresAt: Date.now() + (j.expires_in - 60) * 1000 };
    return cachedToken.value;
  }

  return {
    async call(tool: string, args: Record<string, unknown>): Promise<unknown> {
      const tok = await getToken();
      const res = await fetch(`${opts.base}/mcp`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tok}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: crypto.randomUUID(),
          method: 'tools/call',
          params: { name: tool, arguments: args },
        }),
      });
      if (!res.ok) throw new Error(`mcp ${tool} ${res.status}: ${await res.text()}`);
      const text = await res.text();
      // SSE response: extract the "data: " line
      const dataLine = text.split('\n').find((l) => l.startsWith('data: '));
      if (!dataLine) throw new Error(`mcp ${tool}: no data line in response`);
      const env = JSON.parse(dataLine.slice(6));
      // env.result.content[0].text is JSON-stringified payload
      return JSON.parse(env.result.content[0].text);
    },
  };
}

// Two singletons: pick the right one per call
export const chatClient = createKosClient({
  base: process.env.KOS_MCP_BASE!,
  clientId: process.env.MAILAGENT_CHAT_CLIENT_ID!,
  clientSecret: process.env.MAILAGENT_CHAT_CLIENT_SECRET!,
});

export const bulkClient = createKosClient({
  base: process.env.KOS_MCP_BASE!,
  clientId: process.env.MAILAGENT_BULK_CLIENT_ID!,
  clientSecret: process.env.MAILAGENT_BULK_CLIENT_SECRET!,
});

// Mnemonic: chatClient writes chat-history/mailagent/... → default source
//           bulkClient writes sources/email/... → mailagent-emails source
```

### 5.2 Bulk email ingest with dedup + retry

```typescript
// ingest-emails.ts
import { bulkClient } from './kos-client';  // bulk emails → mailagent-emails source

interface EmailRecord {
  email_id: string;
  subject: string;
  sender: string;
  recipient: string;
  cc?: string[];
  mailbox: string;
  labels?: string[];
  thread_id?: string;
  date_received: string;  // ISO 8601
  body_markdown: string;
  attachments?: Array<{ name: string; size_mb: number; mime_type: string }>;
}

function buildContent(e: EmailRecord): string {
  const dateOnly = e.date_received.slice(0, 10);
  const ccLine = e.cc && e.cc.length ? `\n> CC: ${e.cc.join(', ')}` : '';
  const labelsLine = e.labels && e.labels.length ? `\n> Labels: ${e.labels.join(', ')}` : '';
  const attachLines = e.attachments?.length
    ? `\n## Attachments\n\n${e.attachments.map((a) => `- ${a.name} (${a.size_mb} MB, ${a.mime_type})`).join('\n')}`
    : '';
  // YAML-escape: single-quote the value and double any internal single quotes
  const esc = (s: string) => `'${s.replace(/'/g, "''")}'`;
  return `---
type: email
kind: source
title: ${esc(e.subject)}
status: stable
created: '${dateOnly}'
updated: '${dateOnly}'
date_received: '${e.date_received}'
sender: ${esc(e.sender)}
recipient: ${esc(e.recipient)}${e.cc?.length ? `\ncc: [${e.cc.map(esc).join(', ')}]` : ''}
mailbox: '${e.mailbox}'${e.labels?.length ? `\nlabels: [${e.labels.map(esc).join(', ')}]` : ''}${e.thread_id ? `\nthread_id: '${e.thread_id}'` : ''}
tags: [email, mailagent-ingest, bulk]
source: mailagent-emails
source_of_truth: mailagent-sqlite
source_refs:
  - mailagent:${e.email_id}
mailagent:
  email_id: ${e.email_id}${e.thread_id ? `\n  thread_id: ${e.thread_id}` : ''}
---

# ${e.subject}

> Ingested via mailagent kos push on ${new Date().toISOString().slice(0, 10)}.
> From: ${e.sender} → To: ${e.recipient}${ccLine}
> Date: ${e.date_received}
> Mailbox: ${e.mailbox}${labelsLine}

${e.body_markdown}${attachLines}
`;
}

export async function ingestEmail(e: EmailRecord, opts: { skipIfExists?: boolean } = {}) {
  const slug = `sources/email/${e.email_id}`;

  // Optional pre-check: skip if already ingested (idempotent re-runs)
  if (opts.skipIfExists) {
    try {
      const existing = await bulkClient.call('get_page', { slug }) as { page?: unknown; error?: string };
      if (existing.page) {
        return { status: 'skipped_existing', slug };
      }
    } catch {
      // get_page not found → proceed to put
    }
  }

  // put_page with retry on 5xx / network errors
  // bulkClient is bound to source_id=mailagent-emails via OAuth.
  // Do NOT pass `source` arg — silently ignored by MCP schema.
  let attempt = 0;
  while (true) {
    try {
      const result = await bulkClient.call('put_page', {
        slug,
        content: buildContent(e),
      }) as { status: string };
      return { status: result.status, slug };
    } catch (err) {
      attempt++;
      if (attempt >= 3) throw err;
      const delay = 1000 * 2 ** attempt;  // exponential backoff: 2s, 4s
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}
```

### 5.3 Batch driver for historical sync

```typescript
// Historical sync, ~5000 emails. Conservative throughput.
const RATE_LIMIT_PER_SEC = 5;  // 5 put_page/sec is conservative for Postgres + embedding
const SLEEP_MS = 1000 / RATE_LIMIT_PER_SEC;

for (const email of historicalEmails) {
  try {
    const r = await ingestEmail(email, { skipIfExists: true });
    console.log(`[${r.status}] ${r.slug}`);
  } catch (err) {
    console.error(`[failed] ${email.email_id}: ${err}`);
    // Continue — don't abort the batch on one failure
  }
  await new Promise((r) => setTimeout(r, SLEEP_MS));
}
```

For a 5000-email batch at 5/sec = ~17 minutes. Brain-side will keep up
(Postgres + Google Gemini embedding is the bottleneck; the embedding
call is ~200ms each, so 5/sec maps to ~1s/email end-to-end, fine).

---

## 6. Validation acceptance (smoke before bulk)

Before kicking off the full 5000-email sync, run this smoke against
the **bulk client** (`mailagent-bulk` credentials). The critical
check is step 4 — verifying the page actually lands in
`mailagent-emails` source, NOT `default`. **If step 4 reports
`source_id: default`, STOP — you're using the wrong OAuth client.**

```bash
# Use the BULK client credentials here, not the chat client.
# Set in your env / .env before running:
#   KOS_MCP_BASE=https://kos.chenge.ink
#   KOS_BULK_CID=gbrain_cl_<bulk-client-id-from-Lucien>
#   KOS_BULK_CSEC=gbrain_cs_<bulk-client-secret-from-Lucien>

# 1. Token exchange works
TOK=$(curl -s -X POST "$KOS_MCP_BASE/token" \
  -d "grant_type=client_credentials" \
  -d "client_id=$KOS_BULK_CID" \
  -d "client_secret=$KOS_BULK_CSEC" \
  -d "scope=read write" | jq -r .access_token)
[ -n "$TOK" ] && [ "$TOK" != "null" ] && echo "  ✓ token" || { echo "FAIL token"; exit 1; }

# 2. mailagent-emails source exists (Lucien must have run gbrain sources add)
SRC=$(curl -s -X POST "$KOS_MCP_BASE/mcp" \
  -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":"1","method":"tools/call","params":{"name":"list_pages","arguments":{"limit":1}}}' \
  | grep '^data: ' | sed 's/^data: //' | jq -r '.result.content[0].text')
echo "$SRC" | jq -e '.pages' >/dev/null && echo "  ✓ source ready" || { echo "FAIL — ping Lucien to gbrain sources add mailagent-emails"; exit 1; }

# 3. put_page round-trip with a single test email
SLUG="sources/email/smoke-$(date +%s)"
PUT_OK=$(curl -s -X POST "$KOS_MCP_BASE/mcp" \
  -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d "$(jq -nc --arg slug "$SLUG" '{
    jsonrpc:"2.0", id:"1", method:"tools/call",
    params:{name:"put_page", arguments:{
      slug:$slug,
      content:"---\ntype: email\nkind: source\ntitle: smoke test\nstatus: draft\ncreated: 2026-05-26\nupdated: 2026-05-26\nsender: smoke@test\nrecipient: lucien@test\nmailbox: test\nsource: mailagent-emails\ntags: [email, mailagent-ingest, smoke-test]\n---\n\n# smoke test\n\nIf you see this, the wire works."
    }}}')" \
  | grep '^data: ' | sed 's/^data: //' | jq -r '.result.content[0].text' | jq -r .status)
[ "$PUT_OK" = "created_or_updated" ] && echo "  ✓ put_page" || { echo "FAIL put_page ($PUT_OK)"; exit 1; }

# 4. CRITICAL — verify the page landed in mailagent-emails source, not default
SRCID=$(curl -s -X POST "$KOS_MCP_BASE/mcp" \
  -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d "$(jq -nc --arg slug "$SLUG" '{
    jsonrpc:"2.0", id:"1", method:"tools/call",
    params:{name:"get_page", arguments:{slug:$slug}}
  }')" \
  | grep '^data: ' | sed 's/^data: //' | jq -r '.result.content[0].text' | jq -r '.page.source_id')
[ "$SRCID" = "mailagent-emails" ] && echo "  ✓ page lands in mailagent-emails source" || { echo "FAIL — page landed in '$SRCID' instead of mailagent-emails. WRONG CLIENT. Verify you're using mailagent-BULK credentials, not the mailagent (chat) client."; exit 1; }

# 4. Roundtrip read back
curl -s -X POST "$KOS_MCP_BASE/mcp" \
  -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d "$(jq -nc --arg slug "$SLUG" '{
    jsonrpc:"2.0", id:"1", method:"tools/call",
    params:{name:"get_page", arguments:{slug:$slug}}
  }')" \
  | grep '^data: ' | sed 's/^data: //' | jq -r '.result.content[0].text' | jq '.page.frontmatter.source'
# expect: "mailagent-emails"

# 5. Cleanup smoke
curl -s -X POST "$KOS_MCP_BASE/mcp" \
  -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d "$(jq -nc --arg slug "$SLUG" '{jsonrpc:"2.0",id:"1",method:"tools/call",params:{name:"delete_page",arguments:{slug:$slug}}}')" \
  >/dev/null

echo "All smoke checks PASS — wire is operational, source is ready, bulk ingest can proceed"
```

**Most common failure**: step 4 reports `source_id: default`. Cause: you're
using the `mailagent` (chat) client credentials instead of the
`mailagent-bulk` credentials. The OAuth client decides source routing,
not the `source` arg in `put_page`. Double-check your env vars and
which client_id you fetched the token with.

---

## 7. Common gotchas

- **Don't mix sources**: chat-save uses `default`, bulk email uses
  `mailagent-emails`. If you put a bulk email into `default`, it
  pollutes Lucien's knowledge brain. The wrapper functions in §5 each
  hardcode the right source — use them, don't roll your own per-call.
- **Slug uniqueness**: each `email_id` must produce a unique slug.
  If you have multiple stores (e.g. archived inbox + active inbox)
  with overlapping IDs, prefix: `sources/email/inbox/<id>` vs
  `sources/email/archive/<id>`. Decide upfront, don't mix.
- **Re-ingest is OK (idempotent)**: `put_page` is upsert. If you
  re-run the historical sync, existing pages are updated (frontmatter
  + body re-embedded). For dedup-cheap behavior pass `skipIfExists`
  in §5.2's helper.
- **Date formats**: `created` / `updated` in frontmatter use
  `YYYY-MM-DD` (date only), `date_received` uses full ISO 8601
  including timezone. The brain indexes on `updated` for recency
  ranking, so set it to the email's send date, not today's date.
- **YAML escaping**: subjects/sender names with special chars (`'`,
  `:`, `[`, `]`) need YAML-escaping. Use single-quoting + double-up
  any internal single quotes (the `esc` helper in §5.2 does this).
  Test with a subject like `Re: 'urgent': don't ignore`.
- **Body 50KB cap**: enforced brain-side (v0.40.10 content sanity
  defense). Truncate client-side first to avoid surprise rejections.
- **Rate limit**: brain has no hard rate limit, but Google Gemini
  embedding has 60 RPM default (free tier). 5 put/sec leaves margin.
  If you see 429s in `put_page` responses, halve the rate.
- **Tokens expire**: 1h TTL. The wrapper in §5.1 auto-refreshes; if
  you implement your own, watch for 401.

---

## 8. Open questions / contact

When uncertain, ping Lucien on Signal or open a GitHub issue against
`ChenyqThu/jarvis-knowledge-os-v2`. Cross-team coordination here
benefits from being asynchronous + written.

Known pending items on Lucien's side:

- [ ] `bin/gbrain sources add mailagent-emails` — Lucien runs when
  ready to receive bulk ingest. Lucien pings you with green light.
- [ ] OAuth `mailagent` client credentials — Lucien transmits via
  secure channel before you start any wire work.

Known pending items on your side:

- [ ] Switch existing chat-save (Sprint 19 P1-C) slug from old prefix
  to `chat-history/mailagent/<email-id>/<session-id>/<message-id>` —
  one constant change. Old pages can be left or migrated; brain has
  no consistency check across slug prefixes.
- [ ] Implement Scenario B (bulk email ingest) using §5's pattern.
- [ ] Run §6's smoke before kicking off historical sync.

---

## Appendix A — Reference links

- Generic MCP wire spec (more OAuth + endpoint details):
  `docs/EXTERNAL-CLIENTS-MCP-WIRE-HANDOFF.md` in
  `ChenyqThu/jarvis-knowledge-os-v2`
- Namespace conventions (covers slug prefix registry):
  `docs/kos-namespace-conventions.md` in same repo
- Brain architecture overview:
  `docs/JARVIS-ARCHITECTURE.md` in same repo

You don't need to clone the brain repo to operate, but those docs are
the source of truth if any wire details here drift over time.
