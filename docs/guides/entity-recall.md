# Entity recall: everything the brain says about an account

GBrain links every page that names an entity to that entity's page: by its
title, by the subject of a record title (`CRM record: Acme Example` → "Acme
Example"), by a frontmatter alias, or by a code the page declares (`Account
code: ACMX`). The `entity` card then lists those pages grouped by type, newest
first, with a short preview, and `get_backlinks` pages through the rest. An
agent briefing on an account sees all of its tickets, meetings and mail
instead of whichever few a search ranks first. The MCP initialize
instructions tell agents to start such a brief with `entity` and walk
`referenced_by` (or `get_backlinks`, where it is served) by type.

**Say to your agent:** *"brief me on the Acme Example account"* —
*"list every open ticket for ACMX"* — *"why isn't this meeting linked to Acme?"*

## Try it (keyless, under a minute)

Nothing here calls a model or needs an API key.

```bash
mkdir -p brain/crm brain/tickets brain/meetings
cat > brain/crm/acme-example.md <<'EOF'
---
type: crm
title: "CRM record: Acme Example"
---
Account code: ACMX
Owner: Alice Example
EOF
for i in 1 2 3; do cat > brain/tickets/ticket-$i.md <<EOF
---
type: ticket
title: "Ticket $i"
date: 2026-0$i-15
---
Customer: ACMX Opened: 2026-0$i-15
Status: $([ $i = 3 ] && echo Open || echo Closed)
EOF
done
cat > brain/meetings/2026-04-03.md <<'EOF'
---
type: meeting
title: "Meeting: Acme Example renewal prep"
---
Renewal blocker: the security review. acmx in lowercase is not the code.
EOF

gbrain init --pglite --no-embedding
gbrain import brain --no-embed
gbrain extract --stale
gbrain entity ACMX
```

`gbrain extract --stale` reports `Mentions: 4 link(s) added, 0 removed from 5 page(s).` and the card reads:

```
CRM record: Acme Example (crm/acme-example) [crm]
  Account code: ACMX
  aka: acme example, acmx
  backlinks: 0 | active facts: 0
  referenced by 4 page(s):
    meeting (1): meetings/2026-04-03
    ticket (3): tickets/ticket-3, tickets/ticket-2, tickets/ticket-1
```

Over MCP (or `gbrain entity ACMX --json`) the card carries the rows:

```json
"referenced_by_count": 4,
"referenced_by": [
  { "canonical_type": "ticket", "total": 3, "rows": [
    { "slug": "tickets/ticket-3", "title": "Ticket 3", "type": "ticket", "canonical_type": "ticket",
      "date": "2026-03-15T00:00:00.000000Z", "date_source": "date",
      "preview": "Customer: ACMX Opened: 2026-03-15 Status: Open" } ] }
],
"coverage": { "state": "complete", "pending_pages": 0, "last_pass_at": "2026-10-04T18:59:54.807Z" }
```

`backlink_count` counts explicit links only; `referenced_by_count` counts every
page that links here, mentions included. A preview is a hint, not evidence:
fetch the page before stating a status or a date.

## Paging a big group

A group shows at most 10 rows and a card at most 50. A truncated group carries
the exact call for the rest:

```json
"next": { "tool": "get_backlinks", "arguments": { "slug": "crm/acme-example", "source_id": "default",
  "type": "ticket", "group": "page", "limit": 50, "cursor": "WyIy..." } }
```

```bash
gbrain backlinks crm/acme-example --type ticket --group page --limit 2
```

returns `{rows, total, truncated, cursor, coverage}`, newest first by
`(date, source, slug)`; pass `cursor` back to continue. Without `group`,
`get_backlinks` returns the link rows it always did (`type` and `limit` filter
them). `type` takes a schema-pack type, one of its aliases (`crm` and
`account` both mean the account group), a type seen on a referring page
(`ticket`), or `untyped`.

## Coverage

`coverage.state` says whether the list can be trusted as complete for names the
brain recognizes in your source:

| State | Meaning | What to do |
|---|---|---|
| `complete` | Every page is scanned at its current content. | Nothing. |
| `pending` | Pages were written since the last pass, or no pass ran yet. | `gbrain extract --stale --catch-up` (free). |
| `failed` | The last pass could not build the name index. | Read `gbrain doctor --only links_extraction_lag --json`, fix, rerun. |
| `disabled` | `auto_link` or `mentions.auto_link` is `false`. | The user's choice; `gbrain config set mentions.auto_link true` reverses it. |
| `type_not_linkable` | Nothing links to this page type by name. | `gbrain config set mentions.entity_types +<type>`. |

Any state but `complete` adds a `[gbrain notice mention_index]` block, so an
agent never reads a short list as "nothing else exists".

## Make your records findable by name

- Give a record page a linkable type. Under the default `gbrain-base-v2` pack
  those are `person`, `company` (and its aliases such as `startup`), `account`
  (alias `crm`), `organization` and `entity`. Other packs add their own
  `primitive: entity` types.
- Put the name in the title, or after a prefix: `CRM record: Acme Example`.
- Declare codes in the body: `Account code: ACMX`, `also known as`, `aka`,
  `short name`, `ticker`, `code name`. A one-word code links only as written
  (`ACMX`, not `acmx`).
- Or list names in frontmatter `aliases: [Acme, Acme Inc]`.

Names are never linked when they are shorter than 4 characters, a generic word
("Will", "Team"), the first word of a longer entity name ("Quormiro" alone when
"Quormiro Capital" and "Quormiro Labs" both exist), claimed by two pages, or
inside a private facts or takes fence. Contracts and other non-entity pages
that repeat a code do not claim it.

## When a name does not link

```bash
gbrain extract mentions --explain acmx --page meetings/2026-04-03
```

```
acmx (source default): case_mismatch
  entry: "ACMX" → crm/acme-example (declared, case-sensitive)
  page meetings/2026-04-03: linked
  This alias is case-sensitive (a single-word declared code) and the text uses a different case.
```

The reason codes are `ambiguous_first_word`, `below_min_length`,
`generic_token`, `alias_collision`, `case_mismatch`, `type_not_linkable`,
`linking_disabled`, `pending`, `ignored_by_page`, `ignored_by_config` and
`not_a_known_name`. Only `pending` is fixed by running `gbrain extract --stale`.

## Settings

| Key | Default | Effect |
|---|---|---|
| `mentions.auto_link` | `true` | `false` removes mention links and derived names on the next sweep; `true` relinks everything on the next sweep. `auto_link=false` also turns it off. |
| `mentions.entity_types` | none | `+type` adds a linkable type, `-type` removes one (person, company, organization and entity always stay). |
| `mentions.ignore` | none | Names never linked, comma-separated or a JSON array. |
| `mentions.exclude_slugs` | none | Pages never linked by any of their names (title or alias), comma-separated or a JSON array of slugs. Use it for an entity whose name is also a common word, such as a person titled 인하 against "로 인하여" ("due to"). The next sweep removes mention links already written to the page. |
| frontmatter `mention_ignore: [names]` | none | Names not linked from that one page. |

Mention links written inside a longer Hangul word, or across a space, by a
matcher older than the Hangul boundary rule (#5829) are stale:
`gbrain doctor` counts them in `stale_mentions`, and
`gbrain extract links --by-mention --rebuild --source db` removes them while
keeping real mentions. A name that is also a common word (a person titled
인하 against "로 인하여") needs `mentions.exclude_slugs`.

## How it stays current

`gbrain extract --stale` (and the autopilot cycle, and the managed-brain stale
path) runs the mention pass after link extraction. It rescans only pages whose
content changed, plus pages a new, removed or renamed entity name can affect,
and it never reruns link or timeline extraction. Sync's own inline extraction
stays link-only. A budgeted cycle gives the mention pass half its time while
pages are due. `gbrain extract --stale --dry-run` shows `mention_due_pages` and
the last pass time.

## Upgrading an existing brain

| Brain | What changes |
|---|---|
| `gbrain-base-v2` (the `init` default) | `account` (alias `crm`) is a new linkable type; CRM rows link by name and code. |
| Legacy `gbrain-base` | Its entity types (person, company, yc, civic, ...) link; no `account` type. Switch packs or add types with `mentions.entity_types`. |
| Custom pack | Every type marked `primitive: entity`, plus its aliases, links. |

After upgrading, `gbrain post-upgrade` names the one command to run:

```bash
gbrain extract --stale --catch-up
```

It reads every page once (free, no model calls). The pass also runs from
autopilot cycles if you skip it.
