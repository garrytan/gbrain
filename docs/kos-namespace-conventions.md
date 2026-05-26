# KOS Namespace Conventions

> **Audience**: implementers writing pages into Jarvis Knowledge OS — both
> external consumers (MailAgent, OpenClaw, Feishu, Notion Knowledge Agent)
> and internal fork-side skills. Companion to
> [`docs/EXTERNAL-CLIENTS-MCP-WIRE-HANDOFF.md`](EXTERNAL-CLIENTS-MCP-WIRE-HANDOFF.md)
> (which covers HOW to talk to the brain; this doc covers WHERE to put data).
>
> **Status**: established 2026-05-23 when MailAgent Sprint 19 P1-C wired
> a [✨ 保存到 KOS] button. Lock the convention before the second consumer
> ships chat-save.

---

## 1. Why this exists

The Jarvis KOS brain is shared by 4+ writers:

| Writer                          | Role                          | Status   |
|---                              |---                            |---       |
| MailAgent (Sprint 19+)          | chat-save + email ingest      | live     |
| OpenClaw                        | chat-save (Sprint 21+ planned)| planned  |
| Feishu signal-detector          | conversation capture (future) | dormant  |
| Notion Knowledge Agent          | read-only enrichment (today)  | live     |
| Internal fork-side skills       | source ingest, concept stubs  | live     |

Without a slug-prefix registry, two consumers will collide on the obvious
names (`conversations/`, `chats/`, `notes/`) and then we have to migrate
slugs after-the-fact. After-the-fact rename invalidates external systems
that pinned slugs, breaks vector-search reranker caches, and is generally
miserable.

This doc is the registry. **Claim a prefix here before shipping code that
writes it.**

---

## 2. Current namespace registry

Only documenting prefixes relevant to cross-consumer coordination. Internal
fork-side directory placement follows upstream
[`skills/RESOLVER.md`](../skills/RESOLVER.md) (20-dir MECE) — not this doc.

| Slug prefix                           | Owner                          | Purpose                                                | Status      |
|---                                    |---                             |---                                                     |---          |
| `sources/notion/<page-id>`            | upstream `notion-importer`     | Notion page ingest (chenge workspace)                  | live        |
| `sources/feishu-<msg-id>`             | retired feishu-bridge          | dormant since 2026-05-05; archived                     | dormant     |
| `sources/handoff-smoke-<ts>`          | infra                          | OAuth wire smoke tests (periodically GC'd by Lucien)   | infra       |
| `sources/v3-cutover-smoke-<date>`     | infra                          | 2026-05-17 v3 cutover smoke artifacts                  | infra       |
| `concepts/<slug>`                     | upstream `enrich` / auto-stub  | GBrain concept pages (Wikipedia-style entries)         | live        |
| `chat-history/<source>/...`           | **shared (this doc)**          | user-curated chat exchanges from any consumer          | **reserved**|

(future writers: add a row here in the PR that lands your code.)

---

## 3. `chat-history/` — the chat-save convention

### 3.1 Slug shape

```
chat-history/<source>/<source-specific-routing>
```

- `chat-history/` — top prefix; enables bulk ops (`list_pages` with prefix
  filter, retention sweeps, reranker tuning per content type).
- `<source>` — one segment, registered below; lets a query narrow to a
  single consumer (`tag: chat-history` + `source: <name>-chat` works too,
  but slug-prefix is cheaper for sweep ops).
- `<source-specific-routing>` — owned by the source; pick whatever
  guarantees uniqueness given that source's underlying entity IDs.

### 3.2 Source segment registry

| `<source>`     | Owner                          | Sample suffix                                    |
|---             |---                             |---                                               |
| `mailagent`    | MailAgent (Sprint 19 P1-C)     | `<email-id>/<session-id>/<message-id>`           |
| `openclaw`     | OpenClaw (Sprint 21+, planned) | TBD when wired                                   |
| `feishu`       | Feishu signal-conversation (future) | TBD                                         |
| `notion-ka`    | Notion Knowledge Agent (future)| TBD                                              |

Concrete example (MailAgent):

```
chat-history/mailagent/eml_a1b2c3/sess_xyz789/msg_42
```

> **Reserving a new source segment**: open a PR to add a row here.
> Don't ship code writing a new `chat-history/<segment>/...` prefix
> until the row lands.

### 3.3 Required frontmatter

```yaml
---
type: conversation              # KOS page kind
kind: source                    # GBrain MECE category (chat is a captured source)
title: <auto-derived, ≤80 chars; first user turn or LLM-summarized>
status: stable                  # or "draft" during multi-turn capture
created: 2026-05-23             # YYYY-MM-DD
updated: 2026-05-23
tags: [chat-history, conversation, <source>]
source: <source>-chat           # e.g. "mailagent-chat", "openclaw-chat"
pinned: false                   # set true to exempt from retention sweeps
<source>:                       # source-specific traceback IDs (free shape)
  email_id: eml_a1b2c3
  session_id: sess_xyz789
  message_id: msg_42
  # ... whatever your consumer needs to round-trip back to its store
---
```

Required keys: `type`, `kind`, `title`, `status`, `created`, `updated`,
`tags`, `source`. The nested `<source>:` block is your namespace — put any
IDs your consumer needs.

### 3.4 Body shape

```markdown
## User

<user message, verbatim>

## Assistant

<assistant response, verbatim>
```

Multi-turn: alternate `## User` / `## Assistant` blocks. Don't add a `## System`
block for the system prompt — it belongs in frontmatter under a `system_prompt`
key if the consumer cares to preserve it, but most chat-save use-cases drop it.

### 3.5 Retention policy

Each source owns its own retention; default suggestion is **90 days** unless
`pinned: true` in frontmatter. Sweep logic lives consumer-side or in a
fork-side `kos-patrol` task — not in upstream gbrain.

Example sweep (caller-side, MCP):

```python
# Find chat-history pages older than 90d, not pinned
old = mcp_call("list_pages", {
    "prefix": "chat-history/",
    "updated_before": (datetime.now() - timedelta(days=90)).isoformat(),
})
for page in old:
    if not page["frontmatter"].get("pinned", False):
        mcp_call("delete_page", {"slug": page["slug"]})
```

(Note: `prefix`, `updated_before` arg names depend on the actual MCP op
shape — check `gbrain serve --http` tools/list at integration time.)

---

## 4. Query patterns

### All saved chats from MailAgent

```python
mcp_call("query", {
    "query": "what did I ask about embedding migrations",
    "filter": {"tag": "chat-history", "source": "mailagent-chat"},
})
```

### Chats touching a specific email thread

```python
mcp_call("list_pages", {"prefix": "chat-history/mailagent/eml_a1b2c3/"})
```

### Cross-consumer chat history (e.g. "all chats from this month")

```python
mcp_call("query", {
    "query": "...",
    "filter": {"tag": "chat-history"},
})
# All consumers get matched; rely on result's frontmatter.source to disambiguate
```

---

## 5. Why `chat-history/` and not `conversations/`

`conversations/` is what MailAgent's first cut used. It's fine semantically
but conflicts with future plans:

- GBrain upstream may grow a "conversation graph" feature (multi-page
  thread-tracking) that would naturally claim `conversations/`.
- `chat-history` is more precise about what's captured: a snapshot of one
  chat exchange, not a live thread.
- `history` prefix signals "subject to retention sweeps" which `conversations`
  doesn't.

Cost of switching: MailAgent flips one `SLUG_PREFIX` constant before this
ships beyond the dev environment.

---

## 6. Why a `<source>` segment and not just `chat-history/<id>`

When OpenClaw ships chat-save (Sprint 21+) it will have its own ID scheme
(workspace_id, session_id) that won't compose with MailAgent's
(email_id, session_id, message_id). Without a `<source>` segment:

- Bulk cleanup ("delete all MailAgent chats older than 90d") becomes a
  scan-all-and-filter-by-tag operation instead of a cheap prefix sweep.
- Two consumers writing similarly-shaped IDs could collide
  (`chat-history/abc123` — is that an email or a workspace?).
- Routing in dashboards / dataclips is uglier.

One extra path segment, zero downside.

---

## 7. Adding a new namespace

This doc covers `chat-history/` in detail because it's the immediately
contested prefix. For other shared namespaces (future `automations/`,
`workflows/`, `inbox/`, etc.):

1. Open a PR adding a row to §2's registry table.
2. Specify owner + purpose + sample slug shape.
3. If multi-consumer (like `chat-history/`), spec out a `<source>` segment
   convention in a new §3-style section.
4. Land the PR before shipping code that writes the prefix.

Lucien is the namespace registrar; ping him on the PR for review.

---

## 8. Links

- Wire spec (HOW to talk to brain): [`docs/EXTERNAL-CLIENTS-MCP-WIRE-HANDOFF.md`](EXTERNAL-CLIENTS-MCP-WIRE-HANDOFF.md)
- Upstream slug resolution / MECE rules: [`skills/RESOLVER.md`](../skills/RESOLVER.md)
- Brain + source two-axes model: [`docs/architecture/brains-and-sources.md`](architecture/brains-and-sources.md)
- Fork architecture: [`docs/JARVIS-ARCHITECTURE.md`](JARVIS-ARCHITECTURE.md)
- MailAgent reference impl (cross-repo): `ChenyqThu/MailAgent` Sprint 19 P1-C
