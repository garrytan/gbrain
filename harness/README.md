# harness — Python LLM Agent for GBrain

**Agent = Model + Harness.** A minimal, military-grade Python LLM agent that runs on top of [GBrain](https://github.com/garrytan/gbrain) as its persistent memory and knowledge layer.

> Part of the **LifeBuilder** digital twin stack. GBrain is the original entity — the persistent brain. This harness is the executor that reads, writes, and acts on it.

---

## Architecture

```
Genspark (planner)          Local AI (executor)
     │                             │
     │ wiki/inbox/ task pages      │
     └─────────────────────────────┘
                  │
            ┌─────▼──────┐
            │  GBrain MCP │  ← knowledge base, wiki, memory
            └─────────────┘
                  ▲
       harness/tools/ talks to GBrain via REST
```

The harness is three things that never change:

| File | Role |
|------|------|
| `loop.py` | Sacred loop — model ↔ tools, ≤50 lines, never touched |
| `store.py` | SQLite run/step/tool_call ledger |
| `llm.py` | Thin Anthropic SDK wrapper |

Tools plug in automatically — drop a `class MyTool(Tool)` in `tools/` and it registers itself.

---

## Tools (18 total)

| Tool | Purpose |
|------|---------|
| `search_memory` | Hybrid search over GBrain |
| `read_memory` | Read a page by slug |
| `write_memory` | Write / update a page |
| `list_pages` | List pages by prefix |
| `bash` | Shell execution |
| `ask_human` | Interrupt for human input |
| `web_fetch` | HTTP fetch |
| `skill_load` | Load agent skill by keyword |
| `skill_list` | List available skills |
| `check_inbox` | Check `wiki/inbox/` for tasks assigned to this agent |
| `get_links` | Get outbound links from a page |
| `get_backlinks` | Get inbound links to a page |
| `get_tags` | Get tags for a page |
| `add_tag` | Add a tag to a page |
| `add_link` | Add a typed link |
| `add_timeline` | Add a timeline entry |
| `get_timeline` | Get timeline for a page |
| `get_stats` | Brain stats snapshot |

---

## Living Documents System

The agent maintains 13 persistent GBrain pages across three layers:

**Manual** (on-demand, load only what you need):
- `wiki/agent-manual` — index + 開工/收工三步
- `wiki/agent-manual/tools` — tool reference
- `wiki/agent-manual/rules` — write safety rules, namespace table
- `wiki/agent-manual/genspark` — Genspark collaboration protocol
- `wiki/agent-manual/workflow` — task execution workflow

**Status** (session-updated living state):
- `wiki/status/session-log` — chronological work log, newest-first
- `wiki/status/priorities` — P0–P3 tasks, progress, session conditions
- `wiki/status/health` — brain stats snapshot with trend tracking
- `wiki/status/orphans` — orphan page list with suggested connections

**Conventions** (reference, rarely changes):
- `wiki/conventions/namespace-rules` — 房多多/興臺/太空艙 namespace table
- `wiki/conventions/frontmatter` — standard YAML format, ai_confidence
- `wiki/conventions/sync-architecture` — Obsidian wins, AI safe zones
- `wiki/workflow/protocol` — Genspark ↔ Local AI collaboration protocol

Push all 13 pages to GBrain:

```bash
GBRAIN_TOTP_SECRET=<secret> python3 scripts/push_manual.py
```

---

## Genspark ↔ Local AI Collaboration

Genspark (cloud) plans. This agent executes. They communicate through `wiki/inbox/`:

```markdown
---
status: pending
assigned_to: local-ai
created_by: genspark
---
## Task
Write a summary of all 房多多 leads from last week...
```

This agent polls the inbox at session start:

```python
check_inbox(assigned_to="local-ai", limit=5)
```

Status machine: `pending → in_progress → done → reviewed`

---

## Military-Grade Contract Pipeline

Every tool change goes through:

```
SPEC → guard:specs → gen:contracts → guard:contracts → IMPL → guard:all
```

```bash
python3 openspec/scripts/guard_specs.py    # format validation
python3 openspec/scripts/gen_contracts.py  # regenerate contracts
python3 openspec/scripts/guard_contracts.py # contract + example validation
```

Zero failed = done. **Never skip a guard.** Never manually edit `*_contract.py`.

See `skills/python-military-grade.md` for the full Python-native pipeline skill.

---

## Setup

```bash
cd harness
pip install -r requirements.txt
```

Set environment variables:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export GBRAIN_BASE=https://brain.yourdomain.com   # or http://127.0.0.1:4244
export GBRAIN_TOTP_SECRET=<your-secret>           # for OTP auth
```

Auth uses daily-rotating OTP (HMAC-SHA256). The tool auto-generates the token on each call — no manual rotation.

---

## Deployment (Railway + Cloudflare)

GBrain runs on Railway. Cloudflare WAF sits in front:

1. **Custom domain**: `brain.yourdomain.com` → Railway service via CNAME
2. **IP whitelist**: Cloudflare WAF Custom Rule blocks all traffic except your IP(s)
3. **OTP auth**: Even if IP slips through, requests need a valid daily OTP

---

## Run

```bash
cd harness
python cli.py "Check inbox, pick up the first pending task, complete it"
```

Every run is logged to `~/.gbrain/harness.db`:

```bash
python cli.py show <run_id>
```

---

## Smoke Test

```bash
cd harness
python3 -c "
import sys; sys.path.insert(0, '.')
from tools import load_tools
tools = load_tools()
print('tools:', sorted(tools.keys()))
"
```

Expected: 18 tools listed.

---

## Contract Guard Smoke Test

```bash
cd harness
python3 openspec/scripts/guard_specs.py
python3 openspec/scripts/gen_contracts.py
python3 openspec/scripts/guard_contracts.py
```

Expected: `N passed, 0 failed` on all three.
