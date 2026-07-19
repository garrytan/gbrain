# Typed personal streams: prefix-per-stream, two-layer records, tier ranking

A pattern for turning a personal brain into the canonical memory layer for
multiple client agents (chat assistants, coding agents, automation forks) that
all read and write over MCP. It uses only shipped gbrain machinery: a user
schema pack, slug-prefix conventions, the source-boost map, the raw-data
sidecar, and (v0.42.63+) the frontmatter-field filter and persistent
`search.source_boosts` config.

Everything below uses placeholder names (`alice-example`, `acme-example`).
Adapt the type set to your own streams.

## The shape

One brain, one host source, one slug prefix per typed stream:

| Stream | Type | Prefix | Tier |
|---|---|---|---|
| People | `person` | `people/` | core |
| Lessons / principles | `lesson` | `lessons/` | core |
| Journal | `journal_entry` | `journal/` | core |
| Decisions | `decision` | `decisions/` | core |
| Agent memory | `agent_memory` | `agent/` | core |
| Saved resources | `resource` | `resources/` | reference |
| Ingested email | `email` | `emails/` | reference |

Why prefixes and not one registered source per stream: `source_id` scopes
slugs, search closures, and access control — eight sources would put
wikilinks (journal → person) across source boundaries. Prefixes give the same
organization AND double as the ranking lever, because the source-boost map
keys on slug prefix.

## Declaring the types

Fork the active base pack and add one type per stream:

```bash
gbrain schema fork gbrain-base-v2 my-streams
gbrain schema add-type lesson        --primitive concept    --prefix lessons/   --pack my-streams
gbrain schema add-type journal_entry --primitive temporal   --prefix journal/   --pack my-streams
gbrain schema add-type decision      --primitive temporal   --prefix decisions/ --pack my-streams
gbrain schema add-type agent_memory  --primitive annotation --prefix agent/     --pack my-streams
gbrain schema add-type resource      --primitive media      --prefix resources/ --pack my-streams
gbrain schema lint my-streams && gbrain schema use my-streams
```

Reuse base types where they exist — the base v2 pack already declares
`person` (`people/`) and `email` (`emails/`); adding a duplicate prefix is
rejected by the pack mutation guard (`prefix_collision`). Audit prefix
occupancy first: pages already living under a prefix silently inherit the new
type inference and any ranking weight you attach to it.

## Deterministic slugs = idempotency

The upsert key is `(source_id, slug)`. Give every stream a deterministic slug
rule and re-ingestion becomes a safe upsert with `page_versions` history:

- `emails/<provider-message-id>` (hex ids fit the slug grammar directly)
- `journal/<YYYY-MM-DD>`
- `resources/<stable-key>` (kebab title, or SHA-256 of the URL)

Slug grammar: segments match `[a-z0-9][a-z0-9-]*`. Keys with characters
outside the allowlist (RFC 822 Message-IDs, exotic external ids) are
normalized as lowercase hex SHA-256 of the raw key. `put_page` does not
enforce the grammar — violations corrupt silently downstream, so normalize at
write time.

## Two-layer records

For bulk/reference streams (email, saved articles), keep search clean:

1. **Page body = distillate.** The 3–8 sentence version worth embedding.
2. **Full original → raw sidecar:** `put_raw_data(slug, source, {raw_body})`.
   Raw data lives outside embeddings, keyword search, and vector search;
   retrieve explicitly with `get_raw_data`.
3. **Order matters:** `put_page` first, then `put_raw_data` — a raw write
   against a missing page throws on Postgres.

Verify the exclusion once per install: plant a nonce token only in a raw
sidecar, confirm `search`/`query` return zero hits for it while
`get_raw_data` returns it.

## Tier ranking

Tier is a frontmatter field (`tier: core|reference`) for provenance and
auditing — ranking keys on prefix via the source-boost map, and scoping keys
on types. Three levers:

1. **Persistent ranking** (v0.42.63+): set the boost map as config so both
   CLI and MCP server processes resolve it durably:

   ```bash
   gbrain config set search.source_boosts '{"resources/":0.8,"emails/":0.8,"lessons/":1.3,"decisions/":1.2}'
   ```

   Resolution: defaults ← config ← `GBRAIN_SOURCE_BOOST` env (env stays the
   emergency override). The resolved map participates in the query-cache key,
   so changing it can never serve stale rankings (one-time cache-miss spike
   after a change is expected).

2. **Tier scoping**: `query` accepts `types[]` — pass the core set
   (`person, lesson, journal_entry, decision, agent_memory`) or the reference
   set (`resource, email`) to hard-scope a query to a tier.

3. **Frontmatter filters** (v0.42.63+): `search`, `query`, and `list_pages`
   accept `frontmatter_filter` predicates (`eq`, `exists`, `missing`, `lt`,
   `lte`, `gt`, `gte`) compiled to indexed JSONB SQL. The canonical example —
   decisions past review with no recorded outcome:

   ```
   query(types: ["decision"], frontmatter_filter: [
     {key: "actual_outcome", op: "missing"},
     {key: "review_by", op: "lt", value: "2026-07-18"}
   ])
   ```

## The write contract lives in the brain

Put the contract itself where every client can read it at runtime: a page
(e.g. `agent/write-contract`) documenting each type's required/optional
fields, slug rules, `put_page` templates, and the standing audit queries.
Point each client agent's persistent memory at that page. The contract-audit
recipe: per type, one `missing`-predicate query per required field — expected
zero rows; anything else names the pages violating the contract.
