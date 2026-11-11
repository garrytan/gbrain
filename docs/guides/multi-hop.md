# Multi-hop relationship questions

GBrain answers questions that chain two or three relationships, such as
"who founded the companies Alice invested in?", by walking the typed links
between pages: from Alice to the companies she invested in, then from those
companies to their founders. Each answer comes back with the links that prove
it, so the agent can show its work. No model call runs on the read path.

**Say to your agent:** *"Who founded the companies Alice invested in?"* —
*"Which other companies did Acme's investors back?"* — *"Who works at the
companies backed by Fund A?"*

## Two ways in

**Ask in plain English (search, query, recall, think).** In the `balanced`
and `tokenmax` modes (`search.relational_planner`, on by default there), a
question that chains 2-3 relationships is planned into typed hops and the answers join the normal search results. Each
chain row carries a `relational` field:

```json
{
  "slug": "people/bob-example",
  "relational": {
    "role": "answer",
    "seed": "people/alice-example",
    "hop": 2,
    "path_count": 1,
    "edges": [
      { "link_type": "invested_in", "stored_from": "people/alice-example", "stored_to": "companies/acme-example", "orientation": "stored", "context": "She backed Acme…", "origin": null },
      { "link_type": "founded", "stored_from": "companies/acme-example", "stored_to": "people/bob-example", "orientation": "flipped", "context": "It was founded by Bob…", "origin": null }
    ]
  }
}
```

`role` is the page's place on the chain: `answer`, `support` (an
intermediate page, such as the company) or `origin` (the page an edge was
written on, when that is a third page). It is not a correctness score, and
`path_count` counts the paths kept for ranking, not independent sources.
The response's `relational_plan` summarizes what the planner did.

**Name the hops yourself (traverse_graph / graph-query).** An agent that
already knows the relationships passes them explicitly and gets an exact,
deterministic chain:

```bash
gbrain graph-query people/alice-example --hop invested_in:object --hop founded:subject
```

```json
traverse_graph {"slug": "people/alice-example",
  "hops": [{"link_type": "invested_in", "toward": "object"},
           {"link_type": "founded", "toward": "subject"}]}
```

`toward` follows the relationship's meaning, not the direction the link was
written in: `object` walks subject → object (investor → company, person →
employer), `subject` walks object → subject (company → founder). Chain link
types: `founded`, `invested_in` (with `led_round`), `advises`, `works_at`,
`attended`, `yc_partner`. Up to 3 hops. With `hops`, the chain sets the walk, so
`depth`, `link_type` and `direction` are ignored and the response names them in
`set_aside`. MCP advertises `hops` on the full surface (the
default); the starter surface leaves it out to stay inside its size budget.

## Try it keyless (about a minute)

```bash
gbrain init --pglite --no-embedding
printf -- '---\ntype: person\ntitle: Bob Example\n---\nBob Example is a robotics engineer.\n' | gbrain put people/bob-example
printf -- '---\ntype: company\ntitle: Acme Example\n---\nAcme Example makes robots. It was founded by [Bob Example](people/bob-example).\n' | gbrain put companies/acme-example
printf -- '---\ntype: person\ntitle: Alice Example\n---\nAlice Example is a seed investor. She backed [Acme Example](companies/acme-example) in 2024.\n' | gbrain put people/alice-example
gbrain graph-query people/alice-example --hop invested_in:object --hop founded:subject
gbrain search "Who founded the companies that Alice Example invested in?" --json
```

The chain answers `people/bob-example`; the second edge is marked "written on
the other page" because the founding is stated on Acme's page. Pages written
before the pages they link to get their links on `gbrain extract links
--source db`. Keyless `think` returns the gathered evidence rather than a
synthesized answer.

## How a question is read

The planner reads the question with a fixed relationship vocabulary (founded /
started / established, invested in / backed / funded / holds a stake in,
advises / serves as an advisor to, works at, attended; verbs, "founded by",
"investors of", "Acme's founders", "Alice's portfolio", "Alice's startups") and
requires exactly one named entity. Polite lead-ins ("could you tell me"),
relative clauses ("the companies in which Alice has invested") and a pronoun
pointing back at the previous step ("Alice advises some companies, who founded
them?") are read as part of the chain. English nests the entity innermost, so
the hops run outward from it. Questions it does not plan, and says so in a
`relational_chain` notice instead of guessing:

- two relationships joined by "and" / "or" ("companies Alice founded and
  invested in" is an intersection, not a chain), unless what follows "and"
  points back with "them" / "those";
- negation ("did not invest"), dates and time windows ("in 2021", "before
  2020"), a tense marker on a relationship that does not end ("formerly
  invested in"), counting and superlatives;
- two named entities, quoted names, or relationships whose page types do not
  chain.

The vocabulary is fixed, so many rewordings are not planned: on the held-out
multi-hop set the planner planned 70% of plainly worded questions and 21% of
reworded ones. A chain question that comes back without `meta.relational_plan`
was not planned; call `traverse_graph` with explicit `hops` instead.

Single-relationship questions ("who invested in Acme?") keep the one-hop
relational arm. Split an unplanned question into one-relationship questions,
or pass explicit `hops`.

## When a chain finds nothing

A chain that finds no answer never hides the ordinary search results; it adds
a `relational_chain` notice that names the reason and the next call:

| Status | Meaning | Next call |
|---|---|---|
| `anchor_not_found` | No visible page matches the named entity | `search` for the entity, then retry with its exact name or slug |
| `no_edges` | The entity has no typed links of the first relationship | `traverse_graph` depth 1 on it (the relationship may only be written as plain mentions) |
| `empty_hop` | A later hop found no typed links | the shorter chain, to inspect the pages it reached |
| `truncated` | A cap was hit (`cap_hit` names the cap and hop) | narrow the question or start from a more specific entity |

Chains read typed links only. Meeting attendance counts when the meeting page
lists attendees in an `Attendees:` or `Participants:` section (see
[attendance evidence](attendance-evidence.md)); a person merely mentioned in a
meeting's notes is not an attendee.

Chains walk relationships that are true today, the same rule every graph read
follows ([temporal edges](temporal-edges.md)): an advisory role or job that
ended is skipped, while events such as founding and investing stay true after
they happen. A tense marker right before a relationship that can end sets
that hop alone: "the companies Alice formerly advised" walks ended advisory
roles, "used to work at" and "worked at" walk every job, "currently works at"
walks live ones; the other hops keep the default. `traverse_graph` with
`hops` walks live relationships, and `graph.edge_validity off` turns the rule off.

## Direction and evidence

Body links keep the direction of the page they are written on: "founded by
Bob" on Acme's page is stored Acme → Bob. Each relationship has a page-type
signature (for example `founded`: person → company; `invested_in`: person or
company → company or deal), and a chain reads a link by that signature:
`stored` when it fits as written, `flipped` when it fits only reversed,
`uncertain` when both fit (company ↔ company investment links, walked as
written at half weight) and not at all when neither fits. Frontmatter,
manual and attendance-section links keep their stored direction.
`search.relational_orient_onehop` (off by default) applies the same reading to
single-relationship questions.

Every page and edge in a chain passes the caller's read scope before anything
is ranked: private, deleted, quarantined and out-of-scope pages never appear
and never move a score. Chains stay inside the start page's source. Remote
callers see edge context only from pages whose text they may read, as a
sanitized excerpt of at most 160 characters.

## Settings

| Key | Effect |
|---|---|
| `search.relational_planner` | Plan 2-3 relationship questions into typed chains (search, query, recall, think). On in `balanced` and `tokenmax`, off in `conservative`; `gbrain config set search.relational_planner false` turns it off |
| `search.relational_orient_onehop` | Single-relationship walks read links written on either page. Off by default; unset follows the planner |
| `search.relational_chain_slots` | When a chain fires, up to this many chain rows (answers, then the pages on their paths) lead page 1; 0..10, default 10, 0 keeps a single evidence slot |

Each chain hop expands at most 50 pages, 100 links per page and 10 paths per
page, so a hub with thousands of links costs a bounded query. See
[retrieval](../architecture/RETRIEVAL.md#multi-hop-relationship-chains) for
where chains sit in the search pipeline.
