# Graph ranking: the most connected entities

`rank_entities` answers "who are the most connected people" or "which companies
have the most inbound links" in one call. Use it instead of grouping link rows
yourself: a hand-written count over `links` counts provenance duplicates,
self-links, deleted pages and redirect stubs, so one entity's duplicate pages
can take the top rows. `get_backlinks` lists who links to one page and
`find_experts` ranks pages for a topic; neither ranks the whole graph.

## Try it

```bash
foresights rank-entities --types '["person"]' --direction in --limit 10 --json
```

The same call from an agent over MCP:

```json
{ "tool": "rank_entities", "arguments": { "types": ["person"], "direction": "in", "limit": 10 } }
```

A row:

```json
{ "slug": "people/alice-example", "title": "Alice Example", "type": "person", "source_id": "default",
  "inbound": 4, "outbound": 1, "neighbors": 5,
  "folded": [{ "slug": "people/al-example-stub", "reason": "superseded_by" }], "folded_total": 1,
  "possible_duplicates": [{ "slug": "people/mayor-example", "title": "Mayor Example", "reason": "title_prefix" }] }
```

## Parameters

| Parameter | Default | Meaning |
|---|---|---|
| `direction` | `in` | Rank by inbound edges (`in`), outbound edges (`out`) or both summed (`both`). Every row carries all three counts. |
| `types` | the schema pack's entity types | Page types to rank, 1 to 20 names. Only the ranked page is filtered; the page on the other end of an edge can be any type. |
| `source_id` | your current source | One source inside your grant, or `__all__` for every source you can read (locally: the whole brain). |
| `link_type` | every ranking type | Count only edges of this type, for example `works_at`. A non-ranking type (`amends`) is refused. |
| `include_mentions` | `false` | Also count mention links (`link_source` `mentions`), as backlink counts do. |
| `limit` | 20 | Rows to return, 1 to 100, applied after folding. |

A value outside these rules is refused with `invalid_params` and a corrected
example; nothing is coerced.

## How counting works

- An edge is a distinct (from page, to page, link_type). Several provenance
  rows for one edge (markdown, frontmatter, manual) count once.
- Both pages must be live: a link to or from a deleted page does not count.
  Both pages must be inside the scope.
- Self-links never count, and neither do non-ranking link types.
- `inbound` and `outbound` count edges, so two typed links from one page
  count twice. `neighbors` counts the distinct pages on the other end, in
  either direction.
- Rows order by the chosen count, highest first; ties order by slug, then
  source id, so the same graph always returns the same order.
- The same slug in two sources is two rows.

## Redirect stubs and duplicates

A retired page (frontmatter `canonical: false`, `superseded_by` or
`merged_into`) whose redirect chain reaches a live page in the same source
within five hops is folded into that page: its edges count toward the target,
edges are deduplicated after folding, and an edge that becomes a self-link is
dropped. The row lists the folded pages under `folded` (at most 10;
`folded_total` counts them all).

Title-prefixed person pages that probably name the same person
(`people/mayor-example` next to `people/alice-example`) are not folded,
because that would be a guess from the name. The top 10 rows list them under
`possible_duplicates`, the same field the `entity` card uses;
`duplicates_checked` says how many rows were checked. `entity.name_variants false`
turns the check off.

## Remote callers

Over MCP a counted edge needs both pages inside your source grant, neither
page private (unless the operator set `search.remote_private_pages`) or
quarantined, both sources unarchived, and the link's origin page, when it has
one, readable on the same terms. A redirect stub folds only into a target you
can read: when the target is hidden, the stub keeps its own row and the
target is never named. A private redirect stub contributes nothing. The local
CLI keeps the trusted view (deleted pages and the scope still apply).

## Coverage

`coverage.state` is `current`, `behind` (link extraction has pages to catch up,
so counts cover only pages whose links are extracted; `note` says so) or
`unread` (the backlog could not be read). The local CLI reads the same backlog
as doctor's `links_extraction_lag` for each source in scope and also gets the
page counts. A remote caller gets the state alone, computed over the pages it
can read (the same rule as the ranking): a private, quarantined or
foreign-source page never makes its coverage `behind`. The brain host catches
up with `foresights extract --stale`.

## rank_entities_timeout

On Postgres the ranking runs under a 15-second statement deadline. A ranking
of a large whole graph that does not finish is refused with
`rank_entities_timeout` rather than returning partial counts. Narrow it with
`source_id`, `types` or `link_type` and call again.
