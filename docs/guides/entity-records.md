# Entity records: contracts, amendments and orders on entity rows

An account's governing terms usually live in a few documents among many: the
contract, its amendments, an order form. GBrain can list those documents where
agents already look, the compact `entity names` rows, the full `entity` card
and `context_pack`, so a later amendment is not lost behind a page of older
hits.

Records are off until you name the page types that count as records. Every
found `entity names` row already carries `referenced_by_count` and a `next` to
its full card.

**Say to your agent:**
- *"Which contracts and amendments reference acme-example?"*
- *"Show me the records for these five accounts."*

## Turn records on

```bash
gbrain config set entity.record_types contract,amendment,order-form
gbrain config get entity.record_types
```

The value is a comma-separated list of page types. A stored type alias is read
as its schema-pack type (with `gbrain-base-v2`, `term-sheet` lists under
`deal`). A type that neither the pack declares nor any page uses gives a
`record_types_undeclared` notice instead of an empty list. Unset it to turn
records off again: `gbrain config unset entity.record_types`.

`entity.names_references` (default `true`) controls the `referenced_by_count`
and card `next` on `entity names` rows; `false` turns them off.

## A record page

```markdown
---
type: amendment
title: Acme Example MSA amendment 2
date: 2026-02-10
status: signed
amends:
  - name: contracts/acme-example-msa
    since: 2026-03-01
---
Amendment 2 to the master services agreement with [Acme Example](../accounts/acme-example.md).
Effective 2026-03-01, the monthly fee changes to 12,000 USD. All other terms are unchanged.
```

- `date` is the page's own date: when it was written or signed. It never
  means "these terms are in effect".
- `status` is shown as `page_status` (any string up to 40 characters; the
  documented convention for unsigned or provisional records is `draft` or
  `unsigned`).
- `amends` is a relationship field: a non-ranking `amends` link to the record
  it changes, with the terms-start date in `since`. Map the field for your page
  type in the schema pack's frontmatter links (example pack:
  `examples/schema-packs/amends-example/pack.yaml`; details in
  [temporal edges](temporal-edges.md#amendments-the-amends-link)), then link the
  pages you already have with `gbrain extract links --source db --include-frontmatter`.
  Without the mapping the page is still a record; it just shows no `amends`.
- Whole-record replacement is a `supersedes` link, which also down-ranks the
  replaced page in search. Use it only when the new record replaces the old one
  entirely.

## Document status on other rows

The same `page_status` rides more than records. Under `entity.row_page_status`
(default `true`), `context_pack` cards (the card's own page) and their
`newer_mentions` rows, and `get_backlinks` link rows and `group: "page"` rows,
carry it whenever the page sets `status`. Set `entity.row_page_status false` to
remove it from those rows only; record rows keep it.

`page_status` is the page's own frontmatter `status`, copied only when it is set
to a string: trimmed, at most 40 characters (longer or non-string values are not
shown). It is never inferred from a title, subject or text, and it does not make
a page lesser evidence. The documented convention for a record that is not in
force yet is `status: draft` or `status: unsigned`; any other string is passed
through as written. Search rows carry the same frontmatter value as raw
`status` (`frontmatter->>'status'`, unbounded and untrimmed), so a search row's
`status` and a pack or backlink row's `page_status` agree whenever the value is
a string of 40 characters or fewer. A link row's `status` is the relationship's
temporal state, a different field, and the `status` input filter is unchanged.

## What the agent gets

`entity {names: ["Acme Example"]}` returns, for the found page (and for each
identity sibling, side by side):

```json
{
  "name": "Acme Example", "found": true, "slug": "accounts/acme-example",
  "referenced_by_count": 14,
  "next": { "tool": "entity", "arguments": { "name": "accounts/acme-example" } },
  "records": [
    { "canonical_type": "amendment", "total": 2, "rows": [
      { "slug": "contracts/acme-example-msa-amendment-2", "title": "Acme Example MSA amendment 2",
        "date": "2026-02-10T00:00:00.000000Z", "date_source": "date", "page_status": "signed",
        "amends": [{ "slug": "contracts/acme-example-msa", "since": "2026-03-01" }] },
      { "slug": "contracts/acme-example-msa-amendment-1", "title": "Acme Example MSA amendment 1",
        "date": "2025-07-01T00:00:00.000000Z", "date_source": "date",
        "amends": [{ "slug": "contracts/acme-example-msa" }] } ] },
    { "canonical_type": "contract", "total": 1, "rows": [
      { "slug": "contracts/acme-example-msa", "title": "Acme Example MSA",
        "date": "2025-01-15T00:00:00.000000Z", "date_source": "date" } ] }
  ]
}
```

Rows are newest page date first, and the order does not say which record
governs. Each page shows at most 5 records (24 per call); a group with more
carries `capped` and a `next` that returns exactly the rest:
`get_backlinks {slug, source_id, type, group: "page", limit, cursor}`.
`context_pack` cards carry the same `records` and render them in `text` under
"Records that reference these entities". When the read fails or runs past its
deadline, rows say `references_unavailable` with a degraded notice: that means
unread, not empty.

## Check which pages count as records

Read-only, no agent needed:

```bash
gbrain config get entity.record_types
gbrain call get_backlinks '{"slug":"accounts/acme-example","type":"amendment","group":"page"}'
gbrain call list_pages '{"type":"amendment"}'
```

Full field contract: [MEMORY_VERBS v1, entity records](../protocol/MEMORY_VERBS_v1.md#entity-records-record-types-enrolled-by-config-additive).
