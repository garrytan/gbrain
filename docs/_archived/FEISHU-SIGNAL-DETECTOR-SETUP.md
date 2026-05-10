# Feishu signal-detector setup (OpenClaw side)

> 2026-04-17 | Phase 2 of `docs/JARVIS-NEXT-STEPS.md`
> Audience: Lucien executing this by hand in `~/.openclaw/workspace/`
> Repo boundary: **this file lives in v2 repo, the steps mutate OpenClaw.**
> We intentionally do NOT check OpenClaw config into this fork — see
> `CLAUDE.md` §"Fork-specific rules".

## What this wires up

Every inbound Feishu message passes through two branches in parallel:

1. **Reply branch** (existing): OpenClaw skill decides how to respond.
2. **Signal branch** (new): a cheap Haiku call scans the message for
   (a) original thinking Lucien voiced, and (b) entity mentions worth
   enriching later.

Signal branch writes directly:

- Original thinking → `POST https://kos.chenge.ink/ingest` with a
  synthesized source page.
- Entity mentions → append one line to
  `~/brain/agent/pending-enrich.jsonl`, consumed by
  `skills/kos-jarvis/enrich-sweep/run.ts` on its next run.

See `skills/kos-jarvis/pending-enrich/SKILL.md` for the queue schema.
See upstream `skills/signal-detector/SKILL.md` for the extraction
contract this re-implements.

## Prerequisites

On the host running OpenClaw (your Mac):

- [ ] `kos-compat-api` launchd service healthy (check
  `launchctl list | grep com.jarvis.kos-compat-api`)
- [ ] `https://kos.chenge.ink/status` returns 200 with current
  `KOS_API_TOKEN`
- [ ] `gemini-embed-shim` healthy on 127.0.0.1:7222 (so the synthesized
  source pages from the reply branch can embed)
- [ ] Anthropic key available to OpenClaw's shell environment
  (Haiku 4.5 is cheap enough for per-message invocation)
- [ ] `skills/kos-jarvis/enrich-sweep/SKILL.md` exists and has been
  reviewed so you know what the queue consumer expects

## Step 1 — Patch the Feishu entry skill

File: `~/.openclaw/workspace/skills/knowledge-os/SKILL.md`

Open in an editor. Find the section that handles inbound messages
(the "on-message" or "intake" block — name varies by OpenClaw version).
Add a **fork block** immediately before the reply logic:

```markdown
### Signal fork (added 2026-04-17 for Jarvis Phase 2)

Before deciding a reply, run Haiku 4.5 on the raw message text with
the signal-detector prompt. The fork is fire-and-forget; the reply
branch does not wait on it.

Prompt template:

> You read one Feishu message from Lucien. Emit a JSON object:
>
> ```
> {
>   "original_thinking": "<full quote or empty string>",
>   "entities": [{"name": "...", "kind": "person|company|concept|project", "context": "..."}]
> }
> ```
>
> Rules:
> - original_thinking: include only if Lucien clearly stated an opinion,
>   framework, or observation that's worth preserving as a brain page.
>   One message == zero or one original. Do not paraphrase.
> - entities: only people/companies/concepts/projects with ≥ 40 chars
>   of surrounding context. Skip generic role titles and pronouns.
>   Cap at 5 per message.
```

## Step 2 — Wire the two downstream actions

Still in `skills/knowledge-os/SKILL.md`, add handlers for the Haiku JSON:

```markdown
### On `original_thinking` non-empty

```bash
curl -sS -X POST \
  -H "Authorization: Bearer $KOS_API_TOKEN" \
  -H "Content-Type: application/json" \
  https://kos.chenge.ink/ingest \
  -d "$(jq -nc --arg body "$ORIGINAL" --arg source "feishu:$CHAT_ID#$MSG_ID" \
        '{markdown:$body,source:$source,kind:"source",tags:["feishu","original-thinking"]}')"
```

(If `kos-compat-api` still lacks a `markdown` field on `/ingest`, fall
back to `/ingest?url=...` by first gisting the text. See
`skills/kos-jarvis/TODO.md` P2 — "upstream kos-compat-api to accept
markdown".)

### On each entity in `entities`

```bash
jq -nc \
  --arg ts "$(date -u +%FT%TZ)" \
  --arg name "$NAME" \
  --arg kind "$KIND" \
  --arg context "$CONTEXT" \
  --arg source "feishu:$CHAT_ID#$MSG_ID" \
  '{ts:$ts,name:$name,kind:$kind,context:$context,source:$source}' \
  >> ~/brain/agent/pending-enrich.jsonl
```
```

## Step 3 — Verify

1. Ensure `~/brain/agent/` exists: `mkdir -p ~/brain/agent`
2. Send a Feishu message to Lucien's bot that mentions a new person,
   e.g.:
   > "Just finished a call with Naval Ravikant. His specific knowledge
   > framework really lands for the Jarvis work."
3. Within 10 seconds:
   - `tail -n 1 ~/brain/agent/pending-enrich.jsonl` should show a
     line with `"name":"Naval Ravikant"`
   - `tail -n 5 skills/kos-jarvis/gemini-embed-shim/shim.stderr.log`
     should show an embed call (from the /ingest auto-embed path) for
     the synthesized source page, if original_thinking fired.
4. On the next `bun run skills/kos-jarvis/enrich-sweep/run.ts --plan`,
   `Naval Ravikant` should appear in the Tier 2 candidate list (mention
   count depends on other pages that reference him).

## Step 4 — Guardrails

- **Latency**: the Haiku call must not block the reply. If your
  OpenClaw version serializes, wrap the fork in `&` (shell) or
  `Promise.allSettled` (TS). Target < 2s total added overhead.
- **Cost**: Haiku 4.5 at ~300 input / 200 output tokens is ~$0.0004 per
  message. 100 messages/day → ~$0.04/day. Acceptable.
- **Failure isolation**: if Haiku errors out, log and continue; never
  block the reply. Missing signals are cheap to recover (run enrich-sweep
  on the message later).
- **Privacy**: the Haiku prompt receives the raw Feishu message. If the
  message contains secrets, Haiku sees them. Do NOT apply this fork to
  DMs with access to sensitive channels without adding a redaction step.

## Rollback

If the fork causes problems (latency, cost, noise), remove it cleanly:

```bash
# In ~/.openclaw/workspace/skills/knowledge-os/SKILL.md, delete the
# "Signal fork" section you added. The reply branch is untouched.
#
# Queue file can stay — enrich-sweep ignores it if empty.
# If you want a clean slate:
mv ~/brain/agent/pending-enrich.jsonl \
   ~/brain/agent/pending-enrich.jsonl.bak-$(date +%s)
```

No state in this v2 repo or in kos-compat-api is affected; the whole
fork lives inside OpenClaw's message handler.

## Acceptance (from JARVIS-NEXT-STEPS.md §4)

- [ ] Feishu message → signal-detector → `pending-enrich.jsonl` append
      observed end-to-end
- [ ] Feishu response latency ≤ 2s overhead (p95)
- [ ] After a week, `enrich-sweep --plan` shows ≥ 5 candidates whose
      only source is `feishu:*`

## Related

- Queue schema: `skills/kos-jarvis/pending-enrich/SKILL.md`
- Consumer: `skills/kos-jarvis/enrich-sweep/SKILL.md`
- Upstream signal extraction logic: `skills/signal-detector/SKILL.md`
- P2 backlog entry that unblocks full original-thinking ingest without
  gist indirection: `skills/kos-jarvis/TODO.md` §"upstream kos-compat-api
  to accept markdown field"
