---
name: feishu-bridge
version: 1.0.0
description: |
  Migration adapter for the existing OpenClaw 飞书 skill. The skill lives
  at ~/.openclaw/workspace/skills/knowledge-os/ and was designed for KOS
  v1 `kos` CLI. This file documents the minimum changes needed when
  pointing that skill at GBrain.
triggers:
  - "update feishu skill"
  - "migrate feishu handler"
tools: []
mutating: false
---

# feishu-bridge Skill

**Scope.** This skill doesn't run at runtime — it's a change-manifest
for the external OpenClaw skill file. Apply once during Week 3.2 cutover.

## External file location

```
~/.openclaw/workspace/skills/knowledge-os/SKILL.md
~/.openclaw/workspace/skills/knowledge-os/cron-*.md   (if exists)
```

## Command mapping (find → replace in OpenClaw skill)

| KOS v1 command | GBrain replacement |
|----------------|--------------------|
| `kos ingest <url>` | `curl -X POST http://127.0.0.1:7225/ingest -H 'Content-Type: application/json' -d '{"url":"<url>"}'` |
| `kos ingest <url> --confirm` | same, then re-run with `--dikw-recompile` helper (TODO: add server flag) |
| `kos query "<q>"` | `curl -X POST http://127.0.0.1:7225/query -H 'Content-Type: application/json' -d '{"question":"<q>"}'` |
| `kos digest --since 7` | `curl http://127.0.0.1:7225/digest?since=7` |
| `kos status` | `curl http://127.0.0.1:7225/status` |
| `kos lint` | `bun run ~/Projects/jarvis-knowledge-os-v2/skills/kos-jarvis/kos-lint/run.ts` |
| `kos patrol` | `bun run ~/Projects/jarvis-knowledge-os-v2/skills/kos-jarvis/kos-patrol/run.ts` (once implemented) |

**Preserved**: 信源分级表（Tier 1/2/3）、手动摄入路径、情报精选、排障教训
入库、对话沉淀规则。这些是 OpenClaw 侧决策逻辑，不随后端切换。

## Cron job endpoints

OpenClaw cron jobs for KOS v1 that need updating:
- `patrol` (daily 08:00) → now calls `bun run kos-patrol/run.ts`
- `lint` (Monday 08:30) → now calls `bun run kos-lint/run.ts`
- `情报入库` (daily 09:30) → unchanged if it still goes through the same
  HTTP endpoint; only kos-compat-api on the other side changed
- `MEMORY 回流` (Sun 22:00) → now calls `bun run digest-to-memory/run.ts`

## Rollback

If Stage 3.2 cutover fails, revert by pointing commands back to the v1
`kos` CLI at `~/Projects/jarvis-knowledge-os/kos`. The v1 repo is frozen
at the `v1-frozen` tag and still runs.

## Cutover checklist (Week 3.2 — historical, completed)

> **Current port**: kos-compat-api runs on **7225** (since 2026-04-28).
> The original Week 3.2 cutover landed kos-compat-api on the v1 port 7220
> for compatibility, then later moved to 7225 to free 7220 for archive.
> The command-mapping URLs above already use 7225; the steps below are
> historical record of the one-time migration.

- [ ] Stop launchd service that runs the v1 kos-api.py (port 7220)
- [ ] Start kos-compat-api.ts via launchd on 7220
- [ ] Verify `curl http://127.0.0.1:7225/health` returns v2 engine marker
- [ ] Test Notion Knowledge Agent (no deploy needed, upstream URL unchanged)
- [ ] Edit OpenClaw skill per mapping table above
- [ ] Send a feishu test message containing a URL → verify ingest
- [ ] Run each cron manually once to confirm
