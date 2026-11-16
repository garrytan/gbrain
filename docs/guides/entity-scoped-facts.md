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

The reply tells you when that happened. A fact that landed on a page names it
in `page`. A fact saved for an entity with no page has no `page`, and its
`write_through` reads `{"written": false, "skipped": "entity_page_missing"}`;
each item of an `items` batch says the same for itself. If the brain's pages
are in a Git repository, the reply also carries an `entity_page_missing`
notice whose step is `ask_user`: tell the user the fact is saved in the
database only and ask whether to create a page for the entity (its
`user_message` says this); if they agree, its fix is the `put_page` call that
creates the page. Once the page exists,
the next maintenance cycle (`gbrain dream`) can move the facts saved for that
entity into the page's Facts table and its file. On a source whose pages are
canonical in Git (`canonical: git`), the fact is not left in the database
alone: it is committed to Git as a row of `memory/unattributed` whose `entity`
column names the entity, before the reply returns. The reply then names
`page: memory/unattributed`, `persistence: {"mode": "filesystem"}` and
`write_through: {"written": true, "held_for": "<entity>"}`. Once the entity
has a page, the next maintenance cycle moves the row into it in one commit
and strikes the held row (`moved to <entity>`; a restricted page's held row is
removed instead); a page kept out of Git does not take it, and the run warns
`HELD_FACT_UNMOVABLE`. An entity under a folder access rule is held on its
folder's own holding page instead (`partners/memory/unattributed` for
`partners/acme-example`): the rules covering the entity cover that page by
path, so the fact has exactly the readers the entity's page would have, and a
folder kept out of Git keeps the page database-only. A rule added later moves
the held rows it covers there in its own apply; the shared page's row is then
removed, so the shared page never names the ruled entity. An entity under an
exact page rule is refused with `git_home_required` (reason `facts_lane`):
create its page with `put_page`, then remember the fact again. A fact the
Google loops extraction finds for such an entity is refused the same way and
nothing is stored for it; the loop is still recorded, and the job's log names
the refusal and the page. Forgetting or
replacing a held fact strikes its row too. A brain with no Git
repository gets no notice: there the database is the record, and the fact is
as safe as everything else in it.

## Related

- [Entity recall](entity-recall.md): how gbrain resolves a name to an entity.
- [MCP tool reference: `recall`](../mcp/TOOL_REFERENCE.md#recall) and
  [`remember`](../mcp/TOOL_REFERENCE.md#remember): every parameter.
- [Fence format](fence-format.md): the facts table columns.
