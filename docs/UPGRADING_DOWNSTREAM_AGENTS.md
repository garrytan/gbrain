# Upgrading Downstream Agents

GBrain ships skills in `skills/`. Downstream agents (Wintermute, OpenClaw deployments,
custom agent forks) often **copy** these skill files into their own workspace and
diverge over time — adding agent-specific phases, removing irrelevant ones, tightening
language. Once that happens, gbrain can't push updates to those forks. The agent has
to apply the diffs by hand.

This doc lists the exact diffs each downstream agent needs to apply when upgrading.
Cross-reference against your fork's local skill files.

## Why this exists

`gbrain upgrade` ships the new binary. `gbrain post-upgrade [--execute --yes]` runs
the schema migrations and backfills the data. But the **skill files themselves**
that tell the agent how to behave — those are user-owned. If your `~/git/wintermute/workspace/skills/brain-ops/SKILL.md`
says `# Based on gbrain v0.10.0` at the top, it doesn't know about v0.12.0 features.

The agent will keep manually calling `gbrain link` after every `put_page` (now redundant —
auto-link does it), miss out on `gbrain graph-query` for relationship questions, and
not know to backfill the structured timeline.

## How to apply

1. Identify your forked skill files. For Wintermute: `~/git/wintermute/workspace/skills/`.
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
   # Based on gbrain v0.12.0 skills/<skill-name>, extended with Wintermute-specific config
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

## Future versions

When gbrain ships a new version, this doc will be updated with the diffs for that
version. Each new version appends a section; old sections stay so you can catch up
multiple versions at once.

To check what your fork is missing:
```bash
diff <(grep -A3 "Based on gbrain" ~/<your-fork>/skills/brain-ops/SKILL.md) \
     <(grep "v[0-9]" ~/gbrain/skills/migrations/ | tail -3)
```
