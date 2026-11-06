# Entity-scoped facts: a different answer per client

When the same question has a different answer for each customer ("what price
did we quote?"), save each answer as a fact about that customer. gbrain stores
the customer on every fact (`entity_slug`), and recall for one customer reads
only that customer's facts, so client A's price never shows up when you ask
about client B.

**Say to your agent:** *"Remember that we quoted client-a-example $5,000 a
year and client-b-example $10,000. When I ask about a client's price, recall
that client's facts, not all prices."*

## Walkthrough

The output below is from a keyless PGLite brain (no embedding provider), so the
question ranking runs on keywords and says so.

**1. Each client has a page.** Pass `entity` as the page slug with its folder.
A name without a folder must match exactly one page: `--entity Client` here is
refused with `entity_unverified` and both client slugs as candidates, and
nothing is saved.

```bash
printf -- '---\ntype: company\ntitle: Client A Example\n---\nA prospect.\n' | gbrain put companies/client-a-example
printf -- '---\ntype: company\ntitle: Client B Example\n---\nA prospect.\n' | gbrain put companies/client-b-example
```

**2. Save each price with its client.**

```bash
gbrain remember 'Quoted annual price is $5,000'  --entity companies/client-a-example --provenance "pricing call 2026-10-20"
gbrain remember 'Quoted annual price is $10,000' --entity companies/client-b-example --provenance "pricing call 2026-10-21"
```

Over MCP it is `remember {fact, entity, provenance}`. Each fact becomes a row
in the client page's `## Facts` table, so it lives in that page's file
([anatomy of a page](page-anatomy.md#facts-and-takes-fences)).

**3. Ask about one client.**

```text
$ gbrain recall companies/client-b-example
📌 id=2 [companies/client-b-example] Quoted annual price is $10,000 (fact, conf 1.00)

$ gbrain recall "Client A Example"
📌 id=1 [companies/client-a-example] Quoted annual price is $5,000 (fact, conf 1.00)
```

`recall {entity}` reads that entity's facts only; the name resolves to the
page by slug, title or alias. Add `question` to rank within the client's facts
(`gbrain recall --entity companies/client-a-example --question "annual price"`
returns the $5,000 row alone).

## When no client is named

`recall {question}` with no entity ranks every fact the caller can read. Today
the result is one flat list, and each row carries its `entity_slug`:

```text
$ gbrain recall --question "annual price"
Facts (ranked by relevance to the question):
  #3 [fact] Standard annual price is $10,000 unless a client has its own quote — pricing policy 2026-10-01 (relevance 0.67)
  #2 [fact] (companies/client-b-example) Quoted annual price is $10,000 — pricing call 2026-10-21 (relevance 0.67)
  #1 [fact] (companies/client-a-example) Quoted annual price is $5,000 — pricing call 2026-10-20 (relevance 0.67)
note: fact ranking degraded (keyword_only_embedding_disabled)
```

gbrain does not merge different claims: each row names its client
(`entity_slug` in `--json` and MCP results), and a row with `entity_slug: null`
was saved with no entity. The same claim saved for several entities can come
back as one row; it then lists every entity in `entity_slugs` with a
`collapsed_count`. Choosing between them is the agent's job, so the agent should:

1. Name the client whenever the conversation is about one, and call
   `recall {entity}`.
2. When no client is named, read `entity_slug` on each row and answer per
   client, or ask which client the person means. Never quote one client's row
   as the answer for another.

Remote (MCP) callers see `world` facts only, so a fact saved `--visibility
private` never reaches them.

## A default for everyone else

A rule like "the standard price is $10,000 unless a client has its own quote"
belongs on a page of its own, so it lives in a file and recall can read it by
name:

```bash
printf -- '---\ntype: concept\ntitle: Pricing policy\n---\nHow we price.\n' | gbrain put concepts/pricing
gbrain remember 'Standard annual price is $10,000' --entity concepts/pricing --provenance "pricing policy 2026-10-01"
```

The agent then checks the client first (`recall companies/client-a-example`)
and falls back to the policy (`recall concepts/pricing`) when the client has
no price of its own. gbrain has no built-in "default unless the entity says
otherwise" rule; the two calls are that rule.

Without `entity`, `remember` attaches the fact to a page only when the text
names exactly one entity page (`entity_inferred: "mention"`; `--infer-entity
false` turns that off). A fact that ends up with no entity, or with an entity
slug that has no page, still saves and still shows up in question recall, but
it has no file to live in: its only copy is in the database
([where your memory lives](where-your-memory-lives.md)). Create the page first.

## Related

- [Entity recall](entity-recall.md): how gbrain resolves a name to an entity.
- [MCP tool reference: `recall`](../mcp/TOOL_REFERENCE.md#recall) and
  [`remember`](../mcp/TOOL_REFERENCE.md#remember): every parameter.
- [Fence format](fence-format.md): the facts table columns.
