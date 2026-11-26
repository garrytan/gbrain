# The value card: what your brain holds and has done for you

`gbrain value` prints one card of real counts about your brain. Nothing is estimated: every row is either a number
gbrain measured, `off` with the command that turns it on, or `unavailable` with a code and the reason. A row never
shows 0 when its number could not be read.

```bash
gbrain value          # the card as text
gbrain value --json   # the same card as a versioned JSON document (schema "gbrain.value", schema_version 1)
```

The text card ends with a link to [how gbrain compares](../proof.md): measured results against simpler setups,
including the ones where the simpler setup wins.

Run it on the computer that holds the brain. In this first version the card is only a local command: agents cannot
call it over MCP (it is not a tool on any MCP surface, `--surface full` included), and a thin client that talks to
a remote brain refuses it.

## What each row counts

The card counts the whole brain, every source and every page, because only the brain's own command line can run it.

| Row | What it counts |
|---|---|
| Conversations archived | Conversations and the days they cover, from the conversation archive's published pages |
| Pages | Live pages by kind (person, company, note, ...) |
| Links | Links between two live pages |
| Facts kept | Facts that are active, superseded by a newer fact, or withdrawn with `forget`; a fact whose page was deleted is not counted as active |
| Lookups served | Searches and recalls search telemetry recorded in the last 30 days, including searches gbrain runs for itself |
| Pages brought up on their own | Pages gbrain put into an agent's context without being asked, in the last 30 days |
| Of those, later retrieved | How many of those pages a search or read later surfaced |
| Nightly items | Items the nightly cycle recorded in the last 30 days (`gbrain learned` shows them), not counting Facts fence rows you typed; it reads "at least N" when the read reaches its 100-item limit; hidden from the text card when there are none |
| Brain score | The doctor's brain score; on a brain with no embedding key it reads "N of N reachable without a key" |

Conversations count only archive pages that were published; a conversation held back by redaction is not counted.

Lookups served counts every search that search telemetry recorded, so it includes searches gbrain runs for itself
(the per-prompt recall check, the nightly cycle, `gbrain eval replay`), not only the ones you or an agent asked for.
A recall that ran a ranked page search counts as that search, any other recall counts as a recall, and a keyword-only
search (`--match keyword`) counts as a search.

Lookups and pages brought up are labelled "best effort, may undercount": telemetry is buffered in each process and
a hard kill drops what was not flushed. "Later retrieved" means a search or read surfaced the page afterwards; it does
not mean a person opened it, and a page surfaced again within 5 minutes of its last retrieval is not recorded again.

Reading the card writes nothing. It does not mark nightly items as seen, and it never runs when an agent session
starts.

## When a counter is off

An off row names the command that turns it on, for example:

- Conversations archived: `gbrain transcripts archive on`
- Of those, later retrieved: `gbrain config set search.track_retrieval true`

An off row is not a failure, so a card whose only gaps are off rows is complete.

## When a count is unavailable

A row whose query fails reads `unavailable (query_failed)` with the error, and the card says it is degraded; the
other rows are still measured. A row that needs a newer schema names that code instead: on a brain without the
learning ledger, Nightly items reads `unavailable (migrations_pending)` and says to run `gbrain apply-migrations --yes`.
When every count fails, `gbrain value` exits non-zero and prints the error
`value_unavailable` (as one JSON error with `--json`): run `gbrain doctor --json` to see why the brain cannot be
read.
