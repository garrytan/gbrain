# Brains and Sources — the mental model

GBrain has two orthogonal axes for organizing knowledge. Users and agents both
need to understand both of them, or queries misroute silently.

**TL;DR:**
- A **brain** is a database. You can have many.
- A **source** is a named repo of content *inside* a brain. One brain can hold many.
- `--brain <id>` picks WHICH DATABASE.
- `--source <id>` picks WHICH REPO WITHIN that database.
- They're independent. You can target any combination.

---

## The two axes

### Brains (the DB axis)

A **brain** is one database — PGLite file, self-hosted Postgres, or Supabase.
Each brain has:
- Its own `pages` table, `chunks` table, `embeddings`, etc.
- Its own OAuth surface if served over HTTP MCP (v0.19+, PR 2).
- Its own separate lifecycle, backup, access control.

Brains are enumerated by:
- **host** — your default brain, configured in `~/.gbrain/config.json`.
- **mounts** — additional brains registered in `~/.gbrain/mounts.json` via
  `gbrain mounts add <id>` (v0.19+).

Routing: `--brain <id>`, `GBRAIN_BRAIN_ID`, `.gbrain-mount` dotfile, or
longest-path match against registered mount paths. Falls back to `host`.

### Sources (the repo axis, v0.18.0+)

A **source** is a named content repo *inside* one brain. Every `pages` row
carries a `source_id`. Slugs are unique per source, not globally.

Example: in one brain, the slug `topics/ai` can exist under `source=wiki`
AND under `source=gstack` — they're different pages.

Routing: `--source <id>`, `GBRAIN_SOURCE`, `.gbrain-source` dotfile, or
registered `local_path` match in the `sources` table.

### When does each axis move?

| You want to | Adjust |
|---|---|
| Work in a different repo within the same brain (wiki → gstack notes) | `--source` |
| Query a team-published brain that isn't yours | `--brain` |
| Isolate a topic so it never leaks into personal search | `--source` with `federated=false` |
| Share a brain with teammates | `--brain` (mount the team brain) |
| Add a new repo to your personal brain | `--source` via `gbrain sources add` |
| Add a team brain | `--brain` via `gbrain mounts add` |

**Rule of thumb:** if the data owner changes, it's a brain boundary. If the
data owner stays the same but the topic/repo changes, it's a source boundary.

---

## Topology: a single-person developer

Simplest case. One brain, one source.

```
┌─────────────────────────────────────────┐
│  host brain (~/.gbrain)                 │
│  ├── source: default (federated=true)   │
│  │   └── all pages                      │
└─────────────────────────────────────────┘
```

`gbrain query "retry budgets"` finds everything. No `--brain`, no `--source`
needed.

---

## Topology: a personal brain with multiple repos

You maintain several codebases or writing streams. Each is its own source
inside one brain. Cross-source search is on by default so a query about
"caching" returns hits from every repo.

```
┌──────────────────────────────────────────────┐
│  host brain (~/.gbrain)                      │
│  ├── source: wiki      (federated=true)      │
│  │   └── personal notes, people, companies   │
│  ├── source: gstack    (federated=true)      │
│  │   └── gstack plans, learnings             │
│  ├── source: openclaw  (federated=true)      │
│  │   └── openclaw docs, memos                │
│  └── source: essays    (federated=false)     │
│      └── draft essays, isolated on purpose   │
└──────────────────────────────────────────────┘
```

Inside `~/openclaw/` the `.gbrain-source` dotfile pins every command to
`source=openclaw`. Inside `~/gstack/` the dotfile pins to `source=gstack`.
Everything still targets one DB.

Use this topology when:
- You own all the content.
- You want cross-repo search to just work.
- You don't need to share any of it with someone who isn't you.

---

## Topology: personal brain + one team brain

You're on a team that publishes a shared brain. Your personal brain stays
as-is; you mount the team brain alongside it.

```
┌──────────────────────────────────────────────┐
│  host brain (~/.gbrain)  — YOUR personal DB  │
│  ├── source: wiki                            │
│  ├── source: gstack                          │
│  └── ...                                     │
└──────────────────────────────────────────────┘

┌──────────────────────────────────────────────┐
│  mount: media-team                           │
│  path:   ~/team-brains/media                 │
│  engine: postgres (team's Supabase)          │
│  └── sources: wiki, raw, enriched            │
└──────────────────────────────────────────────┘
```

`gbrain query "X"` (no flags) → runs against host (your personal brain).
`gbrain query "X" --brain media-team` → runs against the team's DB.
Inside `~/team-brains/media/` a `.gbrain-mount` dotfile pins brain to
`media-team` automatically.

Use this topology when:
- You're on a team and someone publishes a brain the team subscribes to.
- You need data isolation between work and personal.
- Different teams/orgs own different brains.

---

## Topology: a CEO-class user with multiple team memberships

You're senior enough to sit across multiple teams. You maintain your personal
brain (with N sources inside) AND mount several work team brains. Each team
brain is itself a multi-source brain in the v0.18.0 sense — organized
internally however the team owner chose.

```
┌──────────────────────────────────────────────┐
│  host brain — YOUR personal DB               │
│  ├── source: wiki                            │
│  ├── source: essays                          │
│  ├── source: gstack                          │
│  └── source: openclaw                        │
└──────────────────────────────────────────────┘

┌──────────────────────────────────────────────┐
│  mount: media-team (your media team's brain) │
│  └── sources: wiki, pipeline, enriched       │
└──────────────────────────────────────────────┘

┌──────────────────────────────────────────────┐
│  mount: policy-team (your policy team's)     │
│  └── sources: wiki, research, letters        │
└──────────────────────────────────────────────┘

┌──────────────────────────────────────────────┐
│  mount: portfolio (another team's)           │
│  └── sources: companies, deals, diligence    │
└──────────────────────────────────────────────┘
```

Inside each team's checkout, a `.gbrain-mount` dotfile pins the brain. Inside
a specific subdirectory, a `.gbrain-source` dotfile pins the source. So `cd
~/team-brains/policy/research && gbrain query "X"` targets
`brain=policy-team, source=research` with zero flags.

Use this topology when:
- You cross-cut multiple teams.
- Each team owns its own brain with its own access policy.
- You need latent-space federation (agent decides when to query across
  brains), not SQL federation.

Cross-brain queries are **not deterministic** in v0.19. The agent sees the
brain list and re-queries as needed. That's the feature — it keeps debugging
sane and access control clean.

---

## Resolution precedence (one page to remember)

```
WHICH BRAIN (DB)?                    WHICH SOURCE (repo in DB)?
 1. --brain <id>                      1. --source <id>
 2. GBRAIN_BRAIN_ID env               2. GBRAIN_SOURCE env
 3. .gbrain-mount dotfile             3. .gbrain-source dotfile
 4. longest-prefix mount path match   4. longest-prefix source path match
 5. (reserved: brains.default v2)     5. sources.default config
 6. fallback: 'host'                  6. fallback: 'default'
```

Both axes follow the same layered pattern on purpose. If you know one, you
know the other.

---

## For agents reading this

- Default assumption when the user asks a question: start in the current
  brain (resolved via the precedence above). Don't jump brains without a
  reason.
- If the user asks a question that crosses topic areas a team might own
  (e.g. "what did Team X decide last week?"), the right move is to *query
  the team's brain explicitly* rather than searching host with "team x".
- Cross-brain federation is YOUR JOB, not the DB's. You have the brain list
  (`gbrain mounts list`). You decide when to fan out. You synthesize
  findings. You cite `brain:source:slug`.
- When writing a page, respect the brain boundary. A fact about a team's
  work belongs in the team's brain, not in the user's personal brain. Ask
  before writing cross-brain.
- See `skills/conventions/brain-routing.md` for the full decision table.

## For users reading this

- **Default path:** set up your personal brain (`gbrain init`), add a source
  per repo you care about (`gbrain sources add gstack --path ~/gstack`).
  You'll almost never need `--brain`.
- **When a team publishes a brain:** `gbrain mounts add <team-id> --path
  <clone> --db-url <url>` and the `.gbrain-mount` dotfile in that checkout
  routes queries there automatically.
- **When you are the CEO-class user with multiple team memberships:** mount
  each team brain. Trust the resolver — inside a team's directory the
  dotfile picks the brain, inside a subdirectory the dotfile picks the
  source. The flags are for when you want to query across the boundary
  deliberately.

## Further reading

- v0.18.0 CHANGELOG — introduced `sources` primitive.
- v0.19.0 CHANGELOG (TBD after PR 0+1+2 ship) — introduces `mounts`.
- `docs/mounts/publishing-a-team-brain.md` (PR 2) — how to be the brain
  publisher, not just the subscriber.

---

## Token-level source pinning (v37+)

Multi-tenant brains historically relied on agents passing `source_id`
correctly on every call. This works for write paths but **leaks on read
paths via slug collisions**: a token without explicit scope can read any
page from any source by guessing the slug, regardless of which source it
"belongs to".

`v37` (OAuth clients) and `v38` (legacy API keys) make `source_id` a
property of the **credential**, not just of the call. When an OAuth client
or API key is pinned to a source via `gbrain auth set-source[-key]`, that
source becomes a **HARD scope** on all reads and writes for requests
authenticated by that credential.

### Precedence (per-operation)

For every read and write operation:

1. `params.source_id` (explicit) — wins. Admin / cross-source overrides
   route here. Used by tooling that intentionally crosses sources (sync
   migrations, dashboards, debugging).
2. `ctx.defaultSourceId` (token pin) — **HARD scope**, no fallback to
   other sources. The credential is bound to one source; reads MUST NOT
   leak cross-source via slug collisions.
3. neither — unscoped (legacy cross-source visible). Single-source brains
   and untagged tokens keep working unchanged.

This closes the cross-source slug-collision read leak: previously a token
without an explicit scope could read pages from any source by knowing the
slug. With token pinning, that path returns `Page not found`.

### Operations affected (read scope)

All read tools honor the precedence rule:

- `get_page`, `list_pages` — engine-level filter by `source_id`.
- `search`, `query` — engine-level filter via `SearchOpts.sourceId`, plus
  a belt-and-suspenders post-filter.
- `resolve_slugs` — candidate slugs are filtered to those visible in the
  pinned source.
- `get_chunks`, `get_tags`, `get_links`, `get_backlinks`,
  `get_timeline`, `get_versions`, `get_raw_data` — return `[]` when the
  requested slug doesn't exist in the pinned source (cross-source slugs
  are opaque).
- `traverse_graph` — opaque cross-source root; same-source paths only
  when scoped.
- `find_orphans` — filtered to orphans visible in the pinned source.

### Operations affected (write scope)

`put_page` and `import_from_content` apply the same precedence:
explicit `params.source_id` > `ctx.defaultSourceId` > schema DEFAULT
(`'default'`). The dedupe lookup, INSERT, and downstream auto-link all
see the same resolved source so a pinned token cannot accidentally
short-circuit on a hash from another source.

### Configuring a pin

```bash
# Per-OAuth-client (v37)
gbrain auth set-source <client_id> <source_id|none>
gbrain auth list-clients      # shows default_source_id column

# Per-API-key (v38)
gbrain auth set-source-key <name> <source_id|none>
gbrain auth list              # shows default_source_id column
```

`none` (or empty string) clears the pin. Passing `<source_id>` validates
the source exists before persisting.

### Schema

Both `oauth_clients.default_source_id` (v37) and
`access_tokens.default_source_id` (v38) are FKs to `sources(id)` with
`ON DELETE SET NULL`. Deleting the pinned source clears the pin
(subsequent calls fall back to schema DEFAULT) instead of orphaning the
credential.

### Backward compatibility

- Tokens without a pin retain global cross-source behavior. No regression
  for single-source brains or untagged clients.
- `params.source_id` always wins, preserving the admin override path.
- Migrations are idempotent (`ADD COLUMN IF NOT EXISTS`) and safe against
  pre-v37 brains via `isUndefinedColumnError` fallbacks in the verifier.
