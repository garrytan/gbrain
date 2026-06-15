# Brains and Sources — the mental model

GBrain has two orthogonal axes for organizing knowledge. Users and agents both
need to understand both of them, or queries misroute silently.

**TL;DR:**
- A **brain** is a database. You can have many.
- A **source** is a named repo of content *inside* a brain. One brain can hold many.
- A brain-aware command or integration may pass an explicit brain id to pick
  WHICH DATABASE. Do not assume generic CLI verbs accept `--brain` unless their
  help says so.
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

Brain resolver inputs: an explicit brain id from a command or integration that
wires the brain resolver, `GBRAIN_BRAIN_ID`, `.gbrain-mount` dotfile, or
longest-path match against registered mount paths. Falls back to `host`. Current
generic `gbrain query --brain <id>` dispatch is not documented as supported; use
only command paths that advertise brain selection.

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
| Query a team-published brain that isn't yours | Mount the brain, then use a brain-aware command, integration, or agent path that reads the mount. |
| Isolate a topic so it never leaks into personal search | `--source` with `federated=false` |
| Share a brain with teammates | Mount the team brain with `gbrain mounts add`. |
| Add a new repo to your personal brain | `--source` via `gbrain sources add` |
| Add a team brain | `gbrain mounts add` |

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

`gbrain query "retry budgets"` finds everything in the default brain/source. No
separate brain or source selector is needed.

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

Register the mount, then use only command paths or host-agent integrations that
advertise brain-aware dispatch:

```bash
gbrain mounts add media-team \
  --path ~/team-brains/media \
  --engine postgres \
  --db-url postgresql://...
gbrain mounts list
```

Bare `gbrain query "X"` runs against host unless that command path is explicitly
brain-aware. Inside `~/team-brains/media/`, a `.gbrain-mount` dotfile records
`media-team` for resolver-aware paths, but it is not a promise that every CLI
verb switches databases automatically.

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

Inside each team's checkout, a `.gbrain-mount` dotfile records the brain for
resolver-aware paths. Inside a specific subdirectory, a `.gbrain-source` dotfile
records the source. Host agents and integrations that consume both resolvers can
target `brain=policy-team, source=research` without making the operator pass the
ids by hand. Generic CLI verbs still need to advertise that support.

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
 1. explicit brain id from            1. --source <id>
    a brain-aware caller
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
  (e.g. "what did Team X decide last week?"), the right move is to use a
  brain-aware path for the team's brain rather than searching host with
  "team x".
- Cross-brain federation is YOUR JOB, not the DB's. You have the brain list
  (`gbrain mounts list`). Use only command, operation, or host-agent paths that
  actually support cross-brain reads. You decide when to fan out. You synthesize
  findings. You cite `brain:source:slug`.
- When writing a page, respect the brain boundary. A fact about a team's
  work belongs in the team's brain, not in the user's personal brain. Ask
  before writing cross-brain.
- See `skills/conventions/brain-routing.md` for the full decision table.

## For users reading this

- **Default path:** set up your personal brain (`gbrain init`), add a source
  per repo you care about (`gbrain sources add gstack --path ~/gstack`).
  You'll almost never need a separate brain boundary.
- **When a team publishes a brain:** `gbrain mounts add <team-id> --path
  <clone> --engine postgres --db-url <url>`. Use `gbrain mounts list` to verify
  registration, then use a brain-aware host integration or documented
  cross-brain command path to read it.
- **When you are the CEO-class user with multiple team memberships:** mount
  each team brain. Treat `.gbrain-mount` and `.gbrain-source` as routing
  metadata for resolver-aware paths, not as proof that every CLI command can
  switch databases.

## Further reading

- v0.18.0 CHANGELOG — introduced `sources` primitive.
- v0.19.0 CHANGELOG (TBD after PR 0+1+2 ship) — introduces `mounts`.
- `docs/mounts/publishing-a-team-brain.md` (PR 2) — how to be the brain
  publisher, not just the subscriber.
