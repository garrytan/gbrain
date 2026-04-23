# Upgrading Downstream Agents

GBrain ships skills in `skills/`. Downstream agents (custom OpenClaw deployments,
agent forks of any kind) often **copy** these skill files into their own workspace and
diverge over time — adding agent-specific phases, removing irrelevant ones, tightening
language. Once that happens, gbrain can't push updates to those forks. The agent has
to apply the diffs by hand.

This doc lists the exact diffs each downstream agent needs to apply when upgrading.
Cross-reference against your fork's local skill files.

## Why this exists

`gbrain upgrade` ships the new binary. `gbrain post-upgrade [--execute --yes]` runs
the schema migrations and backfills the data. But the **skill files themselves**
that tell the agent how to behave — those are user-owned. If your `~/git/<your-agent>/workspace/skills/brain-ops/SKILL.md`
says `# Based on gbrain v0.10.0` at the top, it doesn't know about v0.12.0 features.

The agent will keep manually calling `gbrain link` after every `put_page` (now redundant —
auto-link does it), miss out on `gbrain graph-query` for relationship questions, and
not know to backfill the structured timeline.

## How to apply

1. Identify your forked skill files. Typically at `~/git/<your-agent>/workspace/skills/` or wherever your agent's skill directory lives.
2. For each skill listed below, find the matching phase/section in your fork.
3. Apply the diff (paste the new block in the indicated location).
4. Update the version banner at the top of your fork (`# Based on gbrain v0.12.0`).
5. Verify: ask the agent to write a test page and confirm the response includes
   `auto_links: { created, removed, errors }`.

Total time: ~10 minutes for all four skills.

---

## 1. brain-ops/SKILL.md

**Where:** Insert a new `### Phase 2.5` section immediately after `### Phase 2: On Every Inbound Signal`.

**Why:** Phase 2.5 declares that auto-link runs automatically. Without this, the
agent's mental model says it must call `gbrain link` after every `put_page`, which
is now redundant and can cause double-add warnings.

```markdown
### Phase 2.5: Structured Graph Updates (automatic)

Every `put_page` call automatically extracts entity references and writes them
to the graph (`links` table) with inferred relationship types. Stale links
(refs no longer in the page text) are removed in the same call. This is
"auto-link" reconciliation.

- No manual `add_link` calls needed for ordinary page writes.
- Inferred link types: `attended` (meeting -> person), `works_at`, `invested_in`,
  `founded`, `advises`, `source` (frontmatter), `mentions` (default).
- The `put_page` MCP response includes `auto_links: { created, removed, errors }`
  so the agent can verify outcomes.
- To disable: `gbrain config set auto_link false`. Default is on.
- Timeline entries with specific dates still need explicit `gbrain timeline-add`
  (or batch via `gbrain extract timeline --source db`).
```

**Also update the Iron Law section.** If your fork still says "Back-links maintained
on every brain write (Iron Law)" without qualification, append:

```markdown
**v0.12.0 update:** Auto-link satisfies the Iron Law for entity-reference links
on every `put_page`. The agent's Iron Law obligation is now: include the
entity reference in the page content (e.g., `[Alice](people/alice)`); auto-link
handles the structured row. Manual `add_link` calls are reserved for
relationships you can't express in markdown content.
```

---

## 2. meeting-ingestion/SKILL.md

**Where:** Append to the end of `### Phase 3: Attendee enrichment`.

**Why:** Eliminates redundant `gbrain link` calls per attendee (auto-link handles them
when the meeting page references attendees as `[Name](people/slug)`).

```markdown
**Note (v0.12.0):** Once the meeting page is written via `gbrain put`, the
auto-link post-hook automatically creates `attended` links from the meeting
to each attendee whose page is referenced as `[Name](people/slug)`. You don't
need to call `gbrain link` for attendees. You DO still need `gbrain timeline-add`
for dated events (auto-link only handles links, not timeline entries).
```

**Where:** In `### Phase 4: Entity propagation`, the line "Back-link from entity page
to meeting page" can be replaced with:

```markdown
4. Entity references in the meeting page body auto-create the link via auto-link.
   For incoming references on the entity page (entity page → meeting page), edit
   the entity page to mention the meeting and `put_page` it — auto-link handles
   the rest.
```

---

## 3. signal-detector/SKILL.md

**Where:** Append to the end of `### Phase 2: Entity Detection`.

**Why:** Same logic as brain-ops — eliminates manual `gbrain link` after writing
originals/ideas pages that reference people or companies.

```markdown
**Auto-link (v0.12.0):** When you write/update an originals or ideas page that
references a person or company, the auto-link post-hook on `put_page`
automatically creates the link from the new page to that entity. You don't
need to call `gbrain link` manually. Timeline entries still need explicit calls.
```

---

## 4. enrich/SKILL.md

**Where:** Replace `### Step 7: Cross-reference` with the v0.12.0 version.

**Why:** Step 7 used to be primarily about creating links between related entity
pages. With auto-link, that's automatic. Step 7 is now about content updates,
not link creation.

Old (delete):
```markdown
### Step 7: Cross-reference

- Update company pages from person enrichment (and vice versa)
- Update related project/deal pages if relevant context surfaced
- Check index files if the brain uses them
- Add back-links manually via `gbrain link` for any new entity references
```

New (paste):
```markdown
### Step 7: Cross-reference

- Update company pages from person enrichment (and vice versa)
- Update related project/deal pages if relevant context surfaced
- Check index files if the brain uses them

**Note (v0.12.0):** Links between brain pages are auto-created on every
`put_page` call (auto-link post-hook). Step 7 focuses on content
cross-references (updating related pages' compiled truth with new signal
from this enrichment), not on creating links. Verify via the `auto_links`
field in the put_page response (`{ created, removed, errors }`).
Timeline entries still need explicit `gbrain timeline-add` calls.
```

---

## After all four diffs are applied

1. **Bump the version banner** at the top of each forked file:
   ```
   # Based on gbrain v0.12.0 skills/<skill-name>, extended with <your-agent>-specific config
   ```

2. **Run the v0.12.0 backfill** (this populates the graph for your existing brain):
   ```bash
   gbrain post-upgrade
   ```
   The v0.12.0 release wires post-upgrade to call `apply-migrations --yes`
   automatically, which runs the v0_12_0 orchestrator (schema → config check →
   `extract links --source db` → `extract timeline --source db` → verify).
   Idempotent; cheap when nothing is pending.

3. **Verify auto-link works:** ask the agent to write a test page that references
   `[Some Person](people/some-person)`. Confirm the put_page response includes
   `auto_links: { created: 1, removed: 0, errors: 0 }`.

4. **Verify graph traversal works:**
   ```bash
   gbrain graph-query people/some-well-connected-person --depth 2
   ```
   Should return an indented tree of typed edges.

---

## v0.12.2 hotfix (data-correctness, no skill edits)

v0.12.2 is a Postgres data-correctness hotfix. No forked skill files need to
change — the skill contracts are unchanged. But you DO need to run the migration,
and you should know about one behavior change in markdown parsing.

### 1. Run the migration (Postgres-backed brains)

```bash
gbrain upgrade
```

The `v0_12_2` orchestrator runs `gbrain repair-jsonb` automatically. It rewrites
rows where `jsonb_typeof = 'string'` across `pages.frontmatter`, `raw_data.data`,
`ingest_log.pages_updated`, `files.metadata`, and `page_versions.frontmatter`.
Idempotent, safe to re-run. PGLite brains no-op cleanly.

Verify after upgrade:

```bash
gbrain repair-jsonb --dry-run --json    # expect totalRepaired: 0
```

### 2. Recover any truncated wiki articles

If your brain imported wiki-style markdown before v0.12.2, some pages were
silently truncated (any standalone `---` in body content was treated as a
timeline separator). Re-import from source:

```bash
gbrain sync --full
```

The new `splitBody` rebuilds `compiled_truth` correctly.

### 3. Know the splitBody contract going forward

`splitBody` now requires an explicit timeline sentinel. Recognized markers
(priority order):

1. `<!-- timeline -->` (preferred — what `serializeMarkdown` emits)
2. `--- timeline ---` (decorated separator)
3. `---` directly before `## Timeline` or `## History` heading (backward-compat)

A bare `---` in body text is now a markdown horizontal rule, not a timeline
separator. If your agent writes pages with a bare `---` delimiter, migrate to
`<!-- timeline -->` — the `serializeMarkdown` helper already does this.

### 4. Wiki subtypes now auto-typed

`inferType` now auto-detects five additional directory patterns as their own
page types (previously they all defaulted to `concept`):

| Path pattern           | New type       |
|------------------------|----------------|
| `/wiki/analysis/`      | `analysis`     |
| `/wiki/guides/`        | `guide`        |
| `/wiki/hardware/`      | `hardware`     |
| `/wiki/architecture/`  | `architecture` |
| `/writing/`            | `writing`      |

If your skills or queries filter by `type=concept` and expect wiki content in
that bucket, update them to include the new types.

---

## v0.13.0 — Frontmatter Relationship Indexing

**Verdict: no action required for most skills.** v0.13 projects YAML frontmatter fields into the graph as typed edges. The ingestion API is unchanged — keep calling `put_page` with frontmatter the way you do today; the graph auto-populates behind the scenes.

Three skills get an optional new phase if you want to consume the new `auto_links.unresolved` response field. Without this, unresolvable frontmatter names silently skip (same as v0.12 behavior).

### 1. meeting-ingestion/SKILL.md (optional)

**Where:** Add a new section after "Phase 3: Write Meeting Page".

```markdown
### Phase 3.5: Check for unresolved attendees (v0.13+)

After `put_page`, inspect `response.auto_links.unresolved` — an array of frontmatter
references that did not resolve to existing pages. For meetings, this usually means
attendees you haven't created a person page for yet.

If `unresolved.length > 0`:
- Option 1 (create pages now): trigger an enrichment pass to build the missing people pages.
- Option 2 (defer): log the unresolved names to the enrichment queue for later.
- Option 3 (accept the gap): the attendee edge will not be created until a page exists.
  Re-running `gbrain extract links --source db --include-frontmatter` after creating
  the page fills in the missing edges.
```

### 2. enrich/SKILL.md (optional)

**Where:** Add to the enrichment trigger list.

```markdown
### Drain unresolved frontmatter names (v0.13+)

If any `put_page` response includes `auto_links.unresolved` entries, the enrichment
tier should pick up those (field, name) pairs and try to create the missing entity
pages. Example flow:

1. signal-detector captures a meeting with `attendees: [Alice Known, Unknown Person]`
2. put_page returns `auto_links.unresolved = [{field: 'attendees', name: 'Unknown Person'}]`
3. enrichment tier consumes `Unknown Person` → web search → creates `people/unknown-person.md`
4. The next put_page (or a backfill run) wires up the `attended` edge automatically
```

### 3. idea-ingest/SKILL.md (optional)

**Where:** Same pattern as meeting-ingestion — check `auto_links.unresolved` after `put_page`, route names to enrichment.

### Unchanged skills (no diffs needed)

- **brain-ops/SKILL.md** — auto-link mechanics are internal; the write path stays the same.
- **signal-detector/SKILL.md** — signal capture path unchanged.
- **query/SKILL.md** — `traverse_graph` now returns richer results automatically.
- **daily-task-manager/SKILL.md**, **briefing/SKILL.md**, **citation-fixer/SKILL.md**, **media-ingest/SKILL.md** — unchanged.

### New edge types you can filter in graph queries

v0.13 edges carry new `link_type` values. If your fork has graph-query skills that filter by type, these are now available:

- `works_at` (person → company) — from `company:`, `companies:`, or `key_people:`
- `founded` (person → company) — from `founded:`
- `invested_in` (investor → deal/company) — from `investors:` or `lead:`
- `led_round` (lead → deal) — from `lead:`
- `yc_partner` (partner → company) — from `partner:`
- `attended` (person → meeting) — from `attendees:`
- `discussed_in` (source → page) — from `sources:`
- `source` (page → source) — from `source:`
- `related_to` (page → target) — from `related:` or `see_also:`

### Migration timing

`gbrain upgrade` takes 2-5 min on a 46K-page brain (one-time). Runs out-of-process via `gbrain post-upgrade`. If your agent holds a DB connection during the upgrade, reconnect after; otherwise keep serving.

### Type normalization NOT in v0.13

Legacy rows with `link_type='attendee'` or `link_type='mention'` coexist with new `'attended'` / `'mentions'` rows. Your queries filtering on old type names keep working. A separate opt-in `gbrain normalize-types` command in v0.14 handles the rename.
## v0.14.0 shell jobs (optional adoption, no skill edits)

Adds a `shell` job type to Minions so deterministic cron scripts (API fetch, token
refresh, scrape + write) move off the LLM gateway. Zero tokens per fire. ~60%
gateway CPU headroom at typical scale. Feature is **off by default**, existing
installs keep running exactly as they did before. Nothing breaks.

To adopt, follow `skills/migrations/v0.14.0.md`. The short version:

1. Set `GBRAIN_ALLOW_SHELL_JOBS=1` on the worker process, then `gbrain jobs work`
   (Postgres). On PGLite, every crontab invocation uses `--follow` for inline
   execution; no persistent worker.
2. Classify each of your host's cron entries: LLM-requiring (keep on gateway) vs
   deterministic (candidate for shell). Typical splits:
   - **Deterministic → shell:** `ycli-token-refresh`, `x-oauth2-refresh`,
     `x-garrytan-unified`, `calendar-sync-to-brain`, `github-pulse`,
     `frameio-scan`, `flight-tracker`, `x-raw-json-backfill`.
   - **LLM-requiring → stay:** `social-radar`, `content-ideas`, `adversary-vacuum`,
     `ea-inbox-sweep`, `morning-briefing`, `brain-maintenance`.
3. For each deterministic cron, rewrite as:
   ```cron
   3 13,16,19,22,1,4,7,10 * * * \
     gbrain jobs submit shell \
       --params '{"cmd":"node scripts/your-script.mjs","cwd":"/data/.openclaw/workspace"}' \
       --max-attempts 3 --timeout-ms 300000
   ```
4. Watch `gbrain jobs get <id>` for exit_code / stdout_tail / stderr_tail on each
   fire. Compare against pre-migration behavior before approving the next batch.

**No skill edits required.** The handler runs worker-side; skill files don't
change. If your host exposed custom handlers via the plugin contract (v0.11.0),
they still work the same way.

Iron rule: **never auto-rewrite the operator's crontab.** Every rewrite is
per-cron, human-approved, with a diff. If you want automation later, the
upcoming `gbrain crontab-to-minions <file>` helper is P1 in TODOS.

---

## v0.16.0: durable agent runtime

v0.15 ships `gbrain agent run` / `gbrain agent logs`, a new `subagent` handler
type in Minions, and a plugin contract for host-repo subagent defs. None of the
existing skills need surgery. The question for downstream agents is *how* to
adopt the new runtime, not how to patch around a breaking change.

### 1. Run a worker with an Anthropic key

The subagent handlers (`subagent` and `subagent_aggregator`) are always
registered on the worker. No separate opt-in flag — `ANTHROPIC_API_KEY` is
the natural cost gate (no key, the SDK call fails on the first turn), and
who-can-submit is already protected (`PROTECTED_JOB_NAMES` + trusted-submit:
MCP callers get `permission_denied`; only `gbrain agent run` can insert
these rows).

```bash
ANTHROPIC_API_KEY=sk-ant-... gbrain jobs work
```

Worker startup prints:

```
[minion worker] subagent handlers enabled
```

### 2. Ship your subagents as a plugin (OpenClaw + similar)

Move your custom subagent definitions out of your gbrain fork and into your own
repo as a plugin. Concretely:

```
~/<your-agent>/gbrain-plugin/
├── gbrain.plugin.json
└── subagents/
    ├── meeting-ingestion.md
    ├── signal-detector.md
    └── daily-task-prep.md
```

`gbrain.plugin.json`:

```json
{
  "name": "your-openclaw",
  "version": "2026.4.20",
  "plugin_version": "gbrain-plugin-v1"
}
```

Each `subagents/*.md` is a plain-text agent definition — YAML frontmatter +
body-as-system-prompt. Recognized frontmatter fields: `name`, `model`,
`max_turns`, `allowed_tools` (must subset the derived brain-tool registry).

Turn it on:

```bash
export GBRAIN_PLUGIN_PATH="$HOME/<your-agent>/gbrain-plugin"
```

Worker startup prints `[plugin-loader] loaded '<name>' v<ver> (N subagents)`
per plugin; any rejection (bad manifest, unknown tool in `allowed_tools`,
version mismatch) shows up as a loud warning at startup, not a silent dispatch-
time failure. See `docs/guides/plugin-authors.md` for the full contract.

### 3. Replace ephemeral subagent runs with durable ones

If your agent currently spawns ephemeral subagents (OpenClaw `Agent()`, ad-hoc
Anthropic API calls, etc.) for work that should survive crashes, sleeps, or
worker restarts, migrate those to `gbrain agent run`. The durability is free:

```bash
gbrain agent run "analyze my last 50 journal pages for recurring themes" \
  --subagent-def analyzer --fanout-manifest manifests/journal-pages.json
```

Every turn persists to `subagent_messages`, every tool call is a two-phase
ledger, and `gbrain agent logs <job>` shows where it died + what the last
successful call returned. No more "re-run from scratch because the session
context evaporated."

### 4. `put_page` from subagents writes under an agent namespace

If you adopted the v0.15 subagent runtime, note that `put_page` calls
originating from a subagent's tool dispatch MUST target
`wiki/agents/<subagent_id>/...`. The schema shown to the model enforces this
on first try; a server-side fail-closed check rejects anything else. This
does NOT affect your skill files, CLI put_page calls, or MCP put_page —
only tool-dispatched writes from inside an LLM loop.

Aggregation output (the final "here's what all N children found" brain page)
goes via a separate trusted CLI path, not through a subagent tool call, so
it can write anywhere you want.

Iron rule: **never grant an agent write access beyond its namespace**. The
server-side check exists because dispatcher bugs happen; treat it as defense
in depth, not the primary boundary.

---

## Future versions

When gbrain ships a new version, this doc will be updated with the diffs for that
version. Each new version appends a section; old sections stay so you can catch up
multiple versions at once.

To check what your fork is missing:
```bash
diff <(grep -A3 "Based on gbrain" ~/<your-fork>/skills/brain-ops/SKILL.md) \
     <(grep "v[0-9]" ~/gbrain/skills/migrations/ | tail -3)
```
