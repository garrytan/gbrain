# Meeting and Slack sources

The `meetings` source kind imports meeting notes from a meeting-notes
provider into brain pages, one page per meeting, on a schedule, with no
custom script. Fireflies is the first provider; others plug in behind the
same provider interface. A Slack channel source kind follows in a later
release and will be documented here.

The feature is opt-in and dormant until you register a meetings source and
run its first sync yourself.

## Setup

### 1. Save the provider's API key

Copy an API key from the provider's settings (Fireflies: Settings, then
Developer settings), then pipe it on stdin:

```bash
printf '%s' "$KEY" | gbrain connectors auth fireflies --token -
```

The key is checked against the provider before it is saved, and saved only
on this machine at `~/.gbrain/connectors/fireflies.json` (mode 0600, the
directory 0700). It is never written to `sources.config`, the database, a
log or an error message. A key passed as an argument (`--token <key>`) is
refused, because the command line lands in shell history and the process
list. A failed check saves nothing unless you add `--force`.

Two environment variables override the saved key, in this order:

- the variable a source names with `--token-env <NAME>` (only that variable
  is read for that source; an unset variable fails instead of falling back);
- `GBRAIN_CONNECTOR_FIREFLIES_TOKEN`.

### 2. Register the source

```bash
gbrain sources add meetings --kind meetings --provider fireflies
```

| Flag | Default | What it does |
|---|---|---|
| `--provider` | `fireflies` | The meeting-notes provider. |
| `--history-days` | 30 | How far back the first sync reaches. |
| `--lookback-days` | 3 | Recent meetings re-read on every sync, so late summaries, edits and deletions converge. |
| `--transcript none\|full` | `none` | `full` also imports the sentence transcript. |
| `--sync-interval-min` | 60 | Minutes between scheduled syncs (floor 5). |
| `--record auto\|git\|database` | `auto` | Where pages are recorded; see below. |
| `--dir` | none | The directory pages are committed to in `git` record mode. |
| `--visibility private` | off | Every page from this source is private. |
| `--token-env` | none | Read the key from this environment variable instead. |
| `--federated` | off | Let meeting pages join unqualified searches. |

### 3. Run the first sync

```bash
gbrain sync --source meetings
```

Nothing syncs on a schedule until this first explicit sync. After it,
autopilot keeps the source fresh every `--sync-interval-min` minutes. When
the provider rate-limits a sync, the time it gives (or the next 00:00 UTC for
a daily quota) is recorded and autopilot waits until then. Without autopilot,
run `gbrain sync --source meetings` from cron through the wrapper in
[cron-schedule.md](cron-schedule.md#calling-gbrain-unattended).

## Record modes

The record mode is chosen once, when the source is added, and stored. It is
never re-inferred later.

- **database** (the default, and the only mode on a brain with no Git
  repository): pages are written to the database with no directory and no
  Git command. The sync position is kept in the database too. A repo-less
  brain is a fully supported configuration.
- **git**: chosen when `--dir` is inside a Git checkout that no other source
  covers, or with `--record git`. Each page is committed to that checkout
  before its database row, so Git stays the parent. `--record git` without
  such a directory is refused; it never falls back to the database. Private
  meetings stay database-only even on a Git-recorded source.

## What is imported

Each meeting page carries the title, date, attendees, organizer, duration,
the provider's summary, action items and keywords, and with `--transcript
full` the transcript. Text from the provider is made inert before it lands
in the page, so a meeting summary cannot plant facts tables, timeline rows,
citations or speaker lines.

A meeting the key's owner did not attend (their email is not the organizer's
or an attendee's) becomes a private page. A meeting the provider is still
processing (no summary yet) is re-checked on every sync and published once
its summary arrives, or after 48 hours without one.

When a meeting changes upstream, its page is updated and the facts extracted
from the old version are retired (struck where they are fenced, and expired
in the database). When a meeting inside the lookback window is deleted
upstream, its page is deleted and its facts are retired the same way.

## Troubleshooting

<a id="connector_auth_required"></a>
### connector_auth_required

The source has no working API key: none was saved, the source's
`--token-env` variable is unset, or the provider rejected the key. Save a
fresh key with `gbrain connectors auth fireflies --token -`, then run
`gbrain sync --source <id>`. Nothing was imported.

<a id="connector_access_denied"></a>
### connector_access_denied

The key works but may not read the meetings asked for. Use a key whose
account can read them, save it, and sync again.

<a id="rate_limited"></a>
### rate_limited

The provider asked gbrain to wait. Progress so far was saved, and autopilot
resumes after the stated time by itself.

<a id="connector_binding_missing"></a>
### connector_binding_missing

A Git-recorded source's checkout is not available. The meeting was held and
not written to the database alone. Restore the checkout (`gbrain sources
status <id>`), then `gbrain sources retry-held <id>`.

<a id="connector_shape_drift"></a>
### connector_shape_drift

A provider response is missing a field gbrain needs, which usually means the
provider changed its API. The meeting was held, never published partially.
Upgrade gbrain; held meetings are retried on later syncs.

<a id="connector_item_too_large"></a>
### connector_item_too_large

A meeting renders larger than 2 MiB (usually a very long full transcript).
It was held, not truncated. Use `--transcript none` for that source.

<a id="connector_response_too_large"></a>
### connector_response_too_large

A provider response exceeded the client's size limit and was not read. The
sync stops without importing that response.
