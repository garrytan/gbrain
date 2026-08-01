---
name: gbrain
description: Search and write the company knowledge brain. Use for any question about the org, people, projects, decisions, or history, and to persist durable knowledge beyond this scope's notebook.
---

# gbrain — the company brain

This sandbox has the `gbrain` CLI connected (thin-client) to the org's central
brain. It is the deep, indexed, cross-source memory: org docs, shared channel
knowledge, and every agent's durable notes. Your scope's own notebook stays the
fast per-turn memory; the brain is where knowledge outlives a scope and becomes
searchable by everyone entitled to it.

## First-run setup (once per sandbox — skip if `gbrain remote doctor` passes)

Your scope's brain credentials arrive via the deployment's secret handoff
(keychain entry or one-time secret drop named `gbrain`). Then:

```bash
gbrain init --mcp-only \
  --issuer-url "https://brain.<org>.com" \
  --mcp-url "https://brain.<org>.com/mcp" \
  --oauth-client-id "<client id from the handoff>" \
  --oauth-client-secret "<client secret from the handoff>"
gbrain whoami   # must succeed before using any other command
```

Pass the secret with `--oauth-client-secret`, not via `GBRAIN_REMOTE_CLIENT_SECRET`:
an env-sourced secret is deliberately NOT written to `~/.gbrain/config.json`, so
every later command would fail with "No client_secret available" once the
variable is out of scope. The flag persists it to the config file on this
sandbox's durable disk, which is what the tool's credential capture expects.

Do not run `gbrain remote doctor` — it needs `admin` scope, which your client
does not have (by design). `gbrain whoami` is the read-scope health check.

## Reading (do this liberally)

```bash
gbrain search "who decided X and why"     # hybrid semantic + keyword search
gbrain get <slug>                          # read one page
gbrain query "question" --json             # search tuned for agent consumption
```

You can read: the shared agent-memory source, org read-only sources (wiki,
handbook), and everything under them. Reads are isolation-enforced server-side;
you only ever see sources your client is entitled to.

## Writing (durable knowledge only, under YOUR prefixes)

Your client is write-fenced to slug prefixes — your own namespace plus the
channels you belong to. Writes outside them are rejected server-side.

```bash
# personal durable memory (your namespace):
gbrain put emp-<your-slug>/people/jane-example --content "..."

# shared channel knowledge (channels you are in):
gbrain put chan-eng/decisions/2026-08-database-choice --content "..."
```

Conventions:
- Write conclusions and durable facts, not chat transcripts. One page per
  entity/decision/topic; update the page rather than appending near-duplicates.
- Markdown with YAML frontmatter; the brain chunks, embeds, and links it.
- Cross-reference liberally: `gbrain link <from> <to>` (from must be in your
  namespace; linking TO any readable page is fine).
- When you learn something channel-relevant in personal work, mirror the
  conclusion into the channel prefix with a `(said in <where>)` provenance
  note.

## When to reach for the brain

- Any question about the org, a person, a project, a decision, or history →
  `gbrain search` FIRST, then answer.
- You produced knowledge with value beyond this conversation → `gbrain put`.
- Something looks wrong (auth errors, empty results you don't expect) →
  `gbrain whoami` to confirm which client and scopes you're using, and report
  its output.
