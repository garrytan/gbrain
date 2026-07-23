# Brain repo layout

A Brain Repo Layout is the editable Markdown shape of your knowledge brain. It
is separate from:

- the GBrain tool repository;
- the database that stores pages, chunks, embeddings, links, facts, jobs, and
  OAuth clients;
- the agent workspace repository that holds skills, prompts, crons, and runtime
  configuration.

Use **Brain Repo Layout** as the generic term. Use **vault** only when talking
about Obsidian-style import or compatibility, such as bare `[[note-name]]`
wikilinks from an existing Obsidian or Notion export.

## Core nouns

| Term | Meaning | Why it matters |
|---|---|---|
| Brain | One database: PGLite, Postgres, or Supabase. | It owns lifecycle, backup, access control, OAuth surface, and mounts. |
| Source | A named content repo inside one brain. | Pages are scoped by `source_id`; the same slug can exist in two sources. |
| Brain repo | The Git repo or folder holding Markdown for one source. | Humans and agents edit this; sync imports it into the database. |
| Schema pack | The active typing and filing contract. | It maps paths to page types, extract behavior, expert routing, and migration rules. |

Rule of thumb: use a new source when the owner stays the same but the repo,
domain, or access scope changes. Use a new brain when ownership, lifecycle,
backup, or access policy changes.

## Recommended starter layout

Start small. The active schema pack can support more directories than you need
on day one.

```text
brain/
  README.md              # human overview for this brain repo
  RESOLVER.md            # filing decision tree for agents and humans
  people/                # one page per person
  companies/             # one page per organization, product, or company
  projects/              # active initiatives and workstreams
  notes/                 # catch-all notes, memos, principles, one-offs
  sources/               # transcripts, references, raw import summaries
  inbox/                 # incoming capture and triage
  archive/               # historical or retired pages
```

Common optional directories, depending on the active pack and your use case:

```text
deals/
emails/
slack/
writing/
media/
tweets/
atoms/
wiki/concepts/
wiki/analysis/
```

Do not create every directory because it exists in an example. A useful
layout is the smallest set of homes that lets humans and agents file new pages
without guessing.

## What a page looks like

GBrain reads normal Markdown with optional YAML frontmatter. It can infer title,
type, slug, and tags, but declaring them explicitly is useful for important
pages.

```markdown
---
title: Alice Example
type: person
tags: [customer, founder]
aliases: ["Alice E."]
---

# Alice Example

Current compiled truth goes here: who Alice is, why she matters, what changed
recently, and what is still open.

---

## Timeline

- 2026-06-01: Met Alice about the acme-example renewal.
```

The content between the second and third `---` delimiters is the current
synthesis. The content below the third delimiter is the event/evidence
timeline. Keep sourced claims in the timeline when they matter for provenance.

## Safe human edits

Humans may safely edit:

- Markdown body text and headings;
- frontmatter fields such as `title`, `tags`, `aliases`, `subtype`, `origin`,
  or domain-specific metadata;
- `RESOLVER.md`, directory `README.md` files, and local filing rules;
- pages in `inbox/` while triaging them into stable homes;
- source-owned repo structure, after checking the active schema pack.

When changing frontmatter, keep scalar values as strings when they are meant to
be strings. GBrain validates malformed frontmatter, but quoted values avoid YAML
coercion surprises.

## GBrain-managed or generated surfaces

Treat these as managed or generated unless you are deliberately changing
routing, provenance, or schema behavior:

| Surface | Owner | Guidance |
|---|---|---|
| Database tables (`pages`, `chunks`, `embeddings`, links, facts, jobs) | GBrain | Do not hand-edit as layout work. Sync and operations own these. |
| `.gbrain-source` | Routing | Pins a checkout or subdirectory to a source. Edit only when changing source routing. |
| `.gbrain-mount` | Routing | Pins a checkout to another brain. Edit only when changing brain routing. |
| `.sources/<source_id>/` | Multi-source render layout | Used when GBrain renders non-default source pages under one brain directory. Prefer registered source checkouts for normal authoring. |
| `.raw/` and `sources/` provenance material | Ingestion/provenance | Prefer append-only updates. Do not rewrite raw evidence only to make prose cleaner. |
| Generated frontmatter such as `dream_generated`, `ingested_via`, `captured_at`, `ingested_at`, `legacy_type` | GBrain or migration jobs | Preserve unless you understand the feature that stamped it. |

The file layer is editable, but it is not the whole system of record. The
database also stores derived retrieval state, source IDs, links, facts, schema
pack state, and operational metadata.

## Sources, sync, and layout

One brain can hold many sources. Each source can have its own local path and its
own layout. Sync imports each source into the same brain database while keeping
slugs scoped by `source_id`.

Common shapes:

| Shape | Layout choice | Sync and backup implication |
|---|---|---|
| One personal brain | One source repo, usually `default`. | Back up the brain repo, the database, and `~/.gbrain/config.json`. |
| Personal multi-source brain | Several source repos inside one brain. | Back up every source repo plus the shared database/config. |
| Shared group brain | Shared sources such as `shared`, `customers`, `internal`. | Back up all source repos, OAuth/source-scope config, and the database. |
| Mounted/cross-team brains | Separate brains with their own sources. | Back up each brain independently; a mount is not a backup. |

Use `docs/architecture/brains-and-sources.md` for the full brain/source routing
model and `docs/architecture/topologies.md` for operating-model and deployment
decisions.

## Schema-pack expectations

The active schema pack decides how paths map to page types. In current GBrain
installs, `gbrain-base-v2` is the canonical default taxonomy: 14 canonical types
plus the `note` catch-all. It uses `path_prefixes` such as `people/`,
`companies/`, `projects/`, `sources/`, `writing/`, and `notes/` to infer page
types, with subtypes and legacy distinctions moved into frontmatter.

Important consequences:

- Layout is configurable; it is not hardcoded to one universal folder tree.
- A custom or legacy brain can use a different pack.
- If an imported Obsidian or Notion vault does not match the active pack, use
  schema detection and review instead of forcing every file into the starter
  layout.
- For shared brains, schema-pack choice can be brain-wide or source-scoped
  depending on the configured resolution tier.

Deeper references:

- `docs/architecture/type-taxonomy.md`: current `gbrain-base-v2` taxonomy.
- `docs/architecture/schema-packs.md`: schema-pack resolution, authoring, and
  recovery.
- `docs/schema-author-tutorial.md`: short custom-pack walkthrough.
- `docs/GBRAIN_RECOMMENDED_SCHEMA.md`: long-form operational-brain layout
  manifesto; useful as design reference, not a mandatory starter tree.

## Backup rule

Back up all layers that would be painful to reconstruct:

1. every Markdown brain repo or source checkout;
2. the GBrain database for each brain;
3. `~/.gbrain/config.json`, source registration, mount registration, OAuth
   clients, and provider configuration;
4. any custom schema packs or `gbrain.yml` layout overrides.

A Git remote for one source is not a full brain backup. A database dump without
the Markdown repos is not a full brain backup either.
