# The value card: what your brain holds and has done for you

`gbrain value` prints one card of real counts about your brain. Agents get the same card from the MCP tool `value`
(read scope). Nothing is estimated: every row is either a number gbrain measured, `off` with the command that turns
it on, or `unavailable` with a code and the reason. A row never shows 0 when its number could not be read.

```bash
gbrain value          # the card as text
gbrain value --json   # the same card as a versioned JSON document (schema "gbrain.value", schema_version 1)
```

## What each row counts

| Row | What it counts | Who sees it |
|---|---|---|
| Conversations archived | Conversations and the days they cover, from the conversation archive's published pages | anyone who reads the archive source |
| Pages | Live pages by kind (person, company, note, ...) | everyone, counted through their own read access |
| Links | Links whose two pages (and the page that produced the link) the caller can read | everyone, the same way |
| Facts kept | Facts that are active, superseded by a newer fact, or withdrawn with `forget` | everyone, the same way |
| Nightly items | Items the nightly cycle recorded in the last 30 days (`gbrain learned` shows them); hidden from the text card when there are none | everyone, the same way |
| Lookups served | Searches, queries and recalls served in the last 30 days | the owner and the local CLI |
| Pages brought up on their own | Pages gbrain put into an agent's context without being asked, in the last 30 days | the owner and the local CLI |
| Of those, later retrieved | How many of those pages a search or read later surfaced | the owner and the local CLI |
| Brain score | The doctor's brain score; on a brain with no embedding key it reads "N of N reachable without a key" | the owner and the local CLI |

Lookups and pages brought up are labelled "best effort, may undercount": telemetry is buffered in each process and
a hard kill drops what was not flushed. A recall that reads only facts counts as one recall; a recall that also
searches pages counts once, as a search. "Later retrieved" means a search or read surfaced the page afterwards; it
does not mean a person opened it.

## Who sees what

Counts of pages, links, facts, conversations and nightly items come from the caller's own read access and source
grant. A member's connection counts only what that member can read, so its numbers do not change when someone adds
pages it cannot see (a page with `readable_by`, a page under a folder rule, a `visibility: private` page). A source
the connection does not read shows as `unavailable (out_of_scope)`.

Lookups served, pages brought up, pages later retrieved and the brain score are brain-wide numbers, so only the brain
owner and the trusted local CLI see them. Any other connection gets those rows as `unavailable (owner_only)`, with no
number.

Reading the card writes nothing: it does not mark nightly items as seen, and it never runs when an agent session
starts.

## When a counter is off

An off row names the command that turns it on, for example:

- Conversations archived: `gbrain transcripts archive on`
- Of those, later retrieved: `gbrain config set search.track_retrieval true`

## When a count is unavailable

A row whose query fails reads `unavailable (query_failed)` with the error, and the card says it is degraded; the
other rows are still measured. When every count fails, `gbrain value` exits non-zero with the error
`value_unavailable`: run `gbrain doctor --json` on the brain host to see why the brain cannot be read.
