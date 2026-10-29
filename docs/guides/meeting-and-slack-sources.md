# Meeting and Slack sources

The `meetings` source kind imports meeting notes from a meeting-notes
provider into brain pages, one page per meeting, on a schedule, with no
custom script. Fireflies is the first provider; others plug in behind the
same provider interface. The `slack` source kind imports chosen Slack
channels, one page per channel per day; see [Slack channels](#slack-channels).

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

## Slack channels

The `slack` source kind reads the channels you name through your own internal
Slack app and writes one page per channel per day at
`slack/<channel-id>/<yyyy-mm-dd>.md`, typed `slack`. Like meetings, it is
dormant until you add a source and run its first sync, and it works on a brain
with no Git repository.

### 1. Create an internal Slack app

Use an app that belongs to your own workspace (Slack: Your apps, then Create
New App, then From an app manifest). An internal app keeps Slack's Tier 3
limits for history reads; an app distributed to other workspaces outside the
Slack Marketplace gets far lower ones. The manifest needs only these bot
scopes:

```yaml
display_information:
  name: gbrain
oauth_config:
  scopes:
    bot:
      - channels:read
      - channels:history
      - groups:read
      - groups:history
      - users:read
settings:
  org_deploy_enabled: false
  socket_mode_enabled: false
```

Install the app to the workspace, then invite it to every channel you want
imported (`/invite @gbrain` in the channel). A hosted service that collects
other people's Slack tokens through a web form needs a review of Slack's API
terms first; this guide covers your own token on your own machine.

### 2. Save the token

Copy the Bot User OAuth Token (`xoxb-…`) from the app's OAuth & Permissions
page and pipe it on stdin:

```bash
printf '%s' "$SLACK_TOKEN" | gbrain connectors auth slack --token -
```

It is checked with `auth.test` before it is saved to
`~/.gbrain/connectors/slack.json` (0600). `--token-env <NAME>` on the
source, then `GBRAIN_CONNECTOR_SLACK_TOKEN`, override the saved token, as for
meetings.

### 3. Register the source

```bash
gbrain sources add slack --kind slack --channels C0123ABCDEF,C0456GHIJKL
```

The channel id is in the channel's details in Slack. Before the source is
registered, gbrain checks the token and every channel: a missing scope or a
channel the app was not invited to refuses with the fix. It then prints which
channels are private. Anyone who can read the brain sees every imported
channel together; Slack's per-channel membership does not carry over to a
shared brain.

| Flag | Default | What it does |
|---|---|---|
| `--channels` | required | Comma-separated channel ids. Direct messages are not supported. |
| `--history-days` | 14 | How far back the first sync reaches. |
| `--lookback-days` | 7 | Recent days re-read on every sync, so edits, deletions and new replies converge. |
| `--timezone` | `UTC` | The IANA zone whose midnight starts a day page. |
| `--sync-interval-min` | 30 | Minutes between scheduled syncs (floor 5). |
| `--max-requests` | 2000 | Requests per sync; a sync that reaches it stops partial and the next one resumes. |
| `--skip bot_message,channel_join` | none | Leave bot messages or join notices out of the pages. |
| `--record auto\|git\|database` | `auto` | Where pages are recorded, as for meetings. |
| `--dir` | none | The directory pages are committed to in `git` record mode. |
| `--visibility private` | off | Every page from this source is private. |
| `--token-env` | none | Read the token from this environment variable instead. |
| `--federated` | off | Let Slack pages join unqualified searches. |

Then run `gbrain sync --source slack` once; autopilot keeps it fresh after
that and waits out Slack's rate limits.

### What a day page holds

Each message is a line `**Name** (YYYY-MM-DD H:MM AM): text` with its own UTC
date and time, the layout the conversation parser reads. Thread replies follow
their parent, marked `↳`, even when they were posted on a later day; a reply
also sent to the channel is marked as such. Mentions, channel links and links
become plain text; edited messages are marked `(edited)`, deactivated users
`(deactivated)`, bots `(bot)`, and a deleted message that still has replies
shows as `(message deleted)`. Message text is made inert like meeting
summaries, so it cannot plant facts tables, citations, timeline rows or speaker
lines.

A day whose messages changed (an edit, a deletion, a new thread reply inside
the lookback) is rebuilt whole, and the facts extracted from the old page are
retired. A day emptied upstream is deleted and its facts are retired. Renaming
a channel changes the title of pages rebuilt after the rename, never their
path.

Coverage limit: a reply to a thread that started before the lookback window is
not imported unless it was also sent to the channel. Raise `--lookback-days`
for channels with long-running threads.

### Private channels

A private channel's pages are `visibility: private`, and on a Git-recorded
source they are kept in the database only. When a channel becomes private,
every page of it is re-published private, its files are removed from the
checkout with a commit, and the facts extracted from it are retired.

A channel the app can no longer read (it was removed from the channel) is held
on later syncs while the other channels keep syncing; invite the app back and
run `gbrain sources retry-held <id>`.

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
account can read them, save it, and sync again. For Slack, the message names
the missing scope (add it to the app, reinstall it and save the new token) or
the channel the app must be invited to.

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
