# Connecting Google (Gmail, Calendar, Contacts)

gbrain's google connector ingests your Gmail threads, calendar events, and
contacts into your brain and runs the [open-loop engine](open-loops.md) on
top: *who is waiting on you, what you promised, and the context needed to
respond.*

Everything is **bring-your-own OAuth**: you use your own (free) Google
OAuth client, so you own the app, the quota, and the tokens. The quickest way
to get one is Google's one-click Personal mode
([below](#personal-mode-one-click-one-client-per-account)). Tokens
live only in your local credential vault (`~/.gbrain/credentials.json`,
mode 0600). The connector is read-only — it never writes to your Google
account (`gmail.readonly`, `calendar.readonly`, `contacts.readonly`).

## The fast path (one command)

```bash
gbrain google setup
```

`setup` walks the whole chain idempotently: guided credential intake →
consent → source registration → a first sync (newest mail first, budgeted so
it finishes fast; the deep backfill resumes automatically on later syncs) →
your first `gbrain waiting` digest. Re-running it is always safe — it
detects what's done and continues.

The pieces, if you want them separately:

```bash
gbrain google connect                 # credentials + consent only
gbrain sources add gmail-you --kind google --account you@example.com
gbrain sync --source gmail-you
gbrain waiting
```

## Personal mode (one click, one client per account)

Google's Personal mode creates a private Google app for one account in one
click: its own Cloud project, no app review, no "unverified app" screen, no
sign-out every 7 days, no credit card, and its own daily request allowance.

```bash
gbrain google setup --personal --account you@example.com
```

The command prints one link (it opens Google's console signed in as that
account). Click **Create**, then **Download JSON** on the client it shows, and
hand the file back:

```bash
gbrain google connect --personal --account you@example.com --client-json ~/Downloads/client_secret.json
```

Approve once in the browser (`--paste` works on a headless machine), and
`setup` carries on with the source and the first sync. Things to know:

- **One client per account.** A Personal-mode client only works for the
  account that created it; another account signing in with it gets
  `client_user_mismatch`. Run the command once per mailbox. Each account's
  client is stored with that account, so connecting one never touches another.
- **Read-only, always.** gbrain asks for read-only scopes and never merges an
  earlier grant of the same client. A consent or token refresh that comes back
  with a scope that can change data (for example `gmail.modify`) is refused
  with `write_scope_refused` and nothing is stored.
- **The client is saved only with a finished consent.** Until the consent
  completes, the client waits in a private 10-minute pending file. A consent
  that fails, or is approved by the wrong account, leaves the vault exactly as
  it was, including the account's previous working connection.
- **Existing connections keep working.** Nothing changes for an account until
  you reconnect it with `--personal`; its source, pages and sync cursor stay.
- **Older gbrain refuses the vault.** Once one account has its own client,
  `credentials.json` is written as version 2. An older gbrain binary then
  refuses to read it instead of overwriting the per-account clients; upgrade
  every gbrain that shares this `GBRAIN_HOME`.

### Move an already-consented grant (`--import`)

To move a grant consented on another machine, pipe one JSON object on stdin:

```bash
gbrain google connect --import - --personal < grant.json
# grant.json: {"account": "you@example.com", "refresh_token": "...",
#              "client": { ...the downloaded client JSON... }}
```

gbrain refreshes the token once, proves the account from Google's answer (the
ID token, or the OpenID userinfo reply), checks every scope is read-only, and
only then writes the client and the grant together. Any failure
(`import_invalid`, `identity_unproven`, `write_scope_refused`, or Google's own
refusal) writes nothing. Delete `grant.json` afterwards.

### Move a mailbox off the shared gbrain.io relay

A Google source set up through gbrain.io reads mail through the shared relay.
To read it through your own Google OAuth client instead, connect the account
first with `gbrain google setup --personal --account you@example.com`, then
run `gbrain sources set-access <source-id> vault`. The source keeps its id,
its private-senders list and its ingest tiers, and it keeps syncing Gmail
only. The command refuses, and changes nothing, until your own connection with
a refresh token is in place (`not_connected`, `no_refresh_token`) and its
grant can read every service the source syncs (`scope_missing`); each refusal
names the setup command to run. On a managed brain it asks first; add `--yes`
once you agree. Pages already imported stay where they are. The next
`gbrain sync --source <source-id>` picks up mail from about a day before the
newest imported message and then follows new mail through Gmail's change
feed. Add `--json` to see the requested and effective access. Running it
again on a source already on vault does nothing.

## One-time Google Cloud setup (~7 minutes)

You need a Desktop-app OAuth client in your own Google Cloud project.
`gbrain google connect` prints this exact checklist when no credentials are
on file:

1. Create (or pick) a project: <https://console.cloud.google.com/projectcreate>
2. Enable the three APIs (one click each):
   - Gmail: <https://console.cloud.google.com/apis/library/gmail.googleapis.com>
   - Calendar: <https://console.cloud.google.com/apis/library/calendar-json.googleapis.com>
   - Contacts (People): <https://console.cloud.google.com/apis/library/people.googleapis.com>
3. Configure the consent screen: <https://console.cloud.google.com/auth/overview>
   - **Google Workspace account** → user type **Internal**. Done — no
     verification, tokens never expire weekly.
   - **Personal gmail.com** → user type **External**, then BOTH:
     a. add your own email as a **Test user** (<https://console.cloud.google.com/auth/audience>), and
     b. click **Publish app** on that same page. *Skipping this makes Google
     silently revoke your tokens every 7 days* — the single most common
     failure in the wild.
4. Create the OAuth client: <https://console.cloud.google.com/auth/clients>
   — application type **Desktop app** (NOT "Web application").
5. Click **Download JSON**.

Then:

```bash
gbrain google connect --client-json ~/Downloads/client_secret_*.json
```

You can also paste the JSON contents on stdin (`--client-json -`), export
`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, or type the pair at the prompt.
Pasted values are sanitized (smart quotes, stray whitespace) and validated
by shape before anything talks to Google.

gbrain records the scopes Google *actually granted* (the consent screen lets
you uncheck scopes), so a narrower-than-needed grant surfaces immediately as
`scope_missing` with the reauth fix attached — never as opaque per-sweep 403s.

During consent Google shows **"Google hasn't verified this app."** That is
YOUR app — click *Advanced → Continue*.

## Headless / SSH / agent-on-another-machine

The connector auto-detects environments where a local browser can't open
(SSH, WSL, containers, no display) and switches to **paste-back mode**: it
prints the consent URL; you open it anywhere, approve, and the browser fails
to load a `http://127.0.0.1:41999/...` page — that's expected. Copy that
page's full address-bar URL and paste it back (interactive prompt), or
complete non-interactively:

```bash
gbrain google connect --paste          # prints the URL, stores flow state
gbrain google connect --code "http://127.0.0.1:41999/?code=...&state=..."
```

Force it anytime with `--paste` or `GBRAIN_FORCE_PASTE=1`.

Note: Google's device-code flow is **not** an option — Gmail/Calendar/
Contacts scopes are excluded from it by Google. Loopback + paste-back is the
supported path.

## Multiple accounts

With Personal mode, run `gbrain google setup --personal --account <email>`
once per account (each gets its own client). Otherwise repeat
`gbrain google connect --account work@yourco.com` per account; each
account becomes its own source (`gbrain sources add gmail-work --kind google
--account work@yourco.com`) with independent sync cursors and locks.

## Contacts next to your own person pages

A Google source renders each contact as a near-empty person page under
`people/<slug>` by default, the same directory a brain repo uses for its own
hand-written profiles. On a multi-source brain that collision has two
costs: mentions in the Gmail source bind to the contact stub instead of the
real profile, and `gbrain doctor` lists the stubs under `junk_entity_hubs`.
Two remedies, independent of each other:

- **Keep contacts out of `people/`.** Add the source with
  `--contacts-dir contacts` (stored as the source's `g_contacts_dir`; any
  relative directory of lower-case segments). Contact pages are found by
  their `google_contact_id`, not by directory, so a source whose directory
  changes moves every contact on its next sweep: the new page lands first,
  then the page under the old directory is retired. The default stays
  `people` for every existing source.
- **Let the stub yield.** With `gbrain config set link_resolution.cross_source
  true`, a mention in the Gmail source of a name that has a real page in
  another source binds to that page instead of the connector's stub (one
  canonical page, or the one sharing the stub's slug; a tie keeps the stub).
  The next mention pass (`gbrain extract --stale`, or autopilot) re-binds
  pages it reaches; `gbrain doctor --only junk_entity_hubs` names the
  canonical twin of each stub and the next step.

### Link each contact to its person page

`gbrain dedupe link-contacts --source <id>` counts how the source's contact
pages would link to your person pages and changes nothing. Add `--apply` to
link them. A contact page joins the identity group of the one person page
whose email or phone is exactly the same as one of the contact's, the rule
the Apple Contacts source uses:

- A name alone never links.
- The same person page copied into other sources (the same slug, the same
  matching email or phone, and a name that agrees, as with a read-only
  mirror) counts as one person: the contact links to every copy, with the
  default source's page as the main one. A copy that carries a different
  email or phone is another candidate.
- A contact whose email or phone matches two or more people, or one person
  whose page has another name (a shared or reused address), stays unlinked
  and waits for you: `gbrain sync status --source <id>` lists it, and
  `gbrain dedupe confirm` or `reject` on those people, or
  `gbrain dedupe decide` ([below](#decide-the-contacts-that-wait)), settles it.
- `gbrain dedupe reject` on a contact and person pair removes that link,
  and the pair is never linked again.
- A contact already in an identity group you made is left as it is.
- Only identity links are written. No page is edited, so what every caller
  can read stays the same.

`--apply` also sets `google_contacts.identity_links` on, so each sync links
the contacts it changed and settles the waiting ones. `--unlink` removes
every link the source made and sets it off.

#### Decide the contacts that wait

`gbrain dedupe link-contacts --source <id> --json` (without `--apply`) also
lists every contact that waits, under `reviews`: its `contact_slug`, the
`reason` (`several_people` or `name_disagrees`) and each candidate as
`source:slug` with what matched it (`email`, `phone` or both, never the
address or number); copies of one page in other sources are listed once,
under `mirrors`, and `link` or `reject` on it covers every copy. Write your choice for each one into a JSON file:

```json
[
  { "contact_slug": "people/c-alice", "action": "link", "candidate": "default:people/alice-example" },
  { "contact_slug": "people/c-bob", "action": "reject" },
  { "contact_slug": "people/c-carol", "action": "reject", "candidate": "default:people/carol-other" },
  { "contact_slug": "people/c-dana", "action": "new" },
  { "contact_slug": "people/c-noreply", "action": "ignore" },
  { "contact_slug": "people/c-erin", "action": "skip" }
]
```

- `link`: the contact and that one candidate are the same person.
- `new`: none of them; a person page named after the contact is made in the
  default source and the contact is linked to it.
- `reject`: a different person from each candidate listed (`candidate`, or a
  `candidates` list), or from every candidate when none is listed. Each pair
  is recorded on its own, so a contact that still matches someone you did not
  reject keeps waiting on that one.
- `ignore`: not a person (a shared inbox, a service): never linked and never
  listed again.
- `skip`: nothing, for now.

```bash
gbrain dedupe decide --source <id> --file choices.json --dry-run   # what each line would do; writes nothing
gbrain dedupe decide --source <id> --file choices.json
```

Every line prints its decision ids and the command that undoes it,
`gbrain dedupe undo <id>...` (plus `gbrain delete <slug> --source default`
for a page `new` made). A line that can't apply (an unknown contact, a
missing candidate, a `link` for a pair you recorded as different, or a
`reject` that names the contact itself) is set aside with its reason and the
rest are still recorded. A refused `link` names the `gbrain dedupe undo`
command that clears the earlier choice; to mark a contact as not a person,
use `ignore`. The decisions are kept with your other
duplicate decisions: in `.gbrain/identity/` in the brain's repository, in one
commit with any page `new` made, so a database rebuilt from git keeps them,
or in the database on a brain with no repository.

### What a contact page carries

Each page records the contact's names, email addresses, organization and
title, phone numbers and user-created contact groups:

- `emails:` is always present (empty for a phone-only contact); `phones:`
  appears when the contact has any, in E.164 form (`+15550100`) where Google
  supplies it, else as entered. Phones are exact identifiers for a manual
  `entity_identity_link` join, not aliases: a digit string never takes part
  in mention matching.
- `groups:` lists the display names of the contact's user-created groups
  (Google's built-in groups such as My Contacts or Starred are omitted). The
  names come from one bounded `contactGroups` read per sweep that needs it;
  when that read fails the sweep uses the names it cached last time, and a
  group it cannot name at all is carried as its raw `contactGroups/<id>`. A
  renamed or deleted group reaches a page when that contact next changes, or
  on `gbrain sync --full`.
- `emails:` and `phones:` hold the values on the contact card itself. In a
  Google Workspace domain Google also returns every address and phone on the
  account the card is linked to, aliases included; those are left out, so a
  card no longer picks up an alias that belongs to someone else's account. A
  card with no address of its own still keeps the linked account's primary
  address, so it can be matched.
- A contact with phones but no email gets a page too; one with no name
  either lives at `contact-<id-hash>` (never at its phone number), and so
  does a contact whose name has no Latin letters or digits (`张三`), which
  keeps its name as the page title. A contact with neither emails nor phones
  renders nothing.
- <a id="contact_page_owned"></a>`contact_page_owned`: when the path a
  contact renders to already belongs to another contact, the contact is
  refused before anything is written or its old page removed, retried on the
  next sync and held after repeated refusals (`gbrain sources status <id>`).
  Rename one of the two contacts in Google, or remove the other page.

The contacts cursor is bound to the field mask that minted it: the People
API rejects a sync token reused with different request parameters, so the
source state records the mask next to the token (`contacts_person_fields`),
commits the two together only after a sweep completed, and lists every
contact once when the mask changes (as it did when phones and groups
arrived). A sync token Google rejects with a 400 that is not an expiry gets
exactly one full-list attempt; if that list fails as well, the error
surfaces and the cursor is left alone.

## Secondary calendars

The calendar sweep reads ONE calendar per source (so each keeps its own
incremental sync token) and defaults to the account's primary calendar.
Shared, subscribed, and secondary calendars the granted `calendar.readonly`
scope already covers are ingested by pointing an additional source at them:

```bash
gbrain google calendars                 # list every calendar the account can
                                        # read (* marks the primary), with ids
gbrain google calendars --json          # { ok, status, account, calendars[],
                                        #   next_action.command } for agents
gbrain sources add family-cal --kind google --account you@example.com \
  --services calendar --calendar-id "family0123456789@group.calendar.google.com"
```

**Say to your agent:** *"list the calendars my google account can read"* —
*"ingest my family calendar into the brain"* (your agent runs
`gbrain google calendars`, then `gbrain sources add … --calendar-id <id>`).

Each source's incremental sync token is bound to the calendar it was minted
for. Re-pointing an existing source at a different calendar (its
`g_calendar_id` config key) is safe: the next sweep notices the change, logs
`[google] calendar changed (<old> → <new>)`, discards the old cursor, and
re-lists the new calendar from a fresh window instead of replaying the old
calendar's delta. Pages already imported from the previous calendar stay in
the brain until you remove them — they are not reconciled automatically.
`gbrain sources set-calendar <source> <calendar-id>` makes that change in one
step and prints the sync to run. On a managed brain the source's sync cursor
is keyed by its configuration, so when the source also syncs Gmail or
Contacts the change makes their next sync re-read history from the start; the
command then refuses with `confirmation_required` (exit 3) until you re-run
it with `--yes`.

### Unreadable calendar

When Google answers the sweep's calendar read with HTTP 403 or 404, the
account cannot read the calendar the source names (a calendar id from another
account, a calendar that was unshared or deleted). Before #5012 that sweep
looked like an empty calendar. Now:

- the sync records `calendar_unreadable` (with the calendar id and HTTP
  status) in the source's state and logs
  `[google] calendar_unreadable: <account> cannot read calendar "<id>"`
  with both fix commands. The run itself does not fail, so Gmail and Contacts
  keep syncing; a readable list clears the record;
- `gbrain google status` probes each linked calendar live (one `events.list`
  read; `--no-probe` reports what the last sync recorded instead), names the
  unreadable one with the fix, and reports `ok: false` and exits 1;
- `gbrain doctor` warns `google_calendar_readable` from the recorded state,
  with no network call.

The fix: list the calendars the account can read, then point the source at
one.

```bash
gbrain google calendars --account you@example.com
gbrain sources set-calendar <source> <calendar-id>   # e.g. primary
gbrain sync --source <source>
gbrain doctor --only google_calendar_readable --json # verify
```

### API access

Each service reads through its own Google Cloud API: Gmail through
`gmail.googleapis.com`, Calendar through `calendar-json.googleapis.com` and
Contacts through `people.googleapis.com`. Every one must be enabled once in
the project that owns your OAuth client, and its scope must be granted at
consent. When one is not:

- `gbrain google setup` probes every service it is about to register before
  it registers anything. A disabled API or an ungranted scope stops setup
  with one report (exit 2, `status: api_access_blocked` under `--json`)
  that names each API, the Google Cloud project, and the enable link from
  Google's own error, plus the narrower `--services` command for the
  services that already work;
- `gbrain google status` probes the services each linked source syncs
  (every granted service when no source is linked yet) and reports them under
  `accounts[].api_access` (`problems` and a `fix`), with `ok: false` and
  exit 1 while any remains;
- the sync records the services it could not reach in the source's state.
  The other services keep syncing and the run is `partial`; a service leaves
  the record once its sweep reaches the API again. `gbrain doctor` warns
  `google_api_access` from that record, with no network call.

The fix's `next` is `ask_user` when an API is disabled (only the project
owner can enable it in the console) and `tell_user_to_run` with
`gbrain google connect --reauth <email>` when only a scope is missing.

```bash
gbrain google status --json   # names every disabled API with its enable link
# enable each one at its link, or reauth for a missing scope, then:
gbrain google status --json   # verify: api_access.problems is empty
gbrain sync --source <source>
```

A managed source resolves its account before any service runs. When no
enabled service can name the account (Gmail profile, Calendar primary
calendar, People `me`), it asks the OAuth userinfo endpoint, which the
`email` scope gbrain always requests can read. So a disabled API is reported
as itself, and `connector_account_changed` means a credential that resolved
to a different account than the source is pinned to.

## Calendar window

Calendar pages cover events from `--history-days` ago up to 60 days from
now (`gbrain sources add … --future-days <n>`, stored as the source's
`g_future_days`, 1..3650, moves that horizon per source), and each sweep
applies that range on its own. That matters for
incremental syncs: after any edit to a recurring series, Google sends back
the series' instances for years before and after, and only those inside the
range are kept. Because the 60-day edge moves forward daily, the sweep also
lists the days it has newly reached, so future instances of a series nobody
touched still appear. If a meeting moves beyond 60 days out, its page goes
away until the meeting is back within range. Meetings that have aged out of
the range keep their pages.

`gbrain sync --source <id> --full` re-lists the whole window and removes the
pages of events that start inside it but are no longer listed (cancelled or
deleted since), and the pages this source wrote for events that start at or
past the horizon (instances a series edit imported years ahead before the
window existed, or under a wider `g_future_days`). It never removes a page
whose event starts before the window, so shrinking `--history-days` keeps
your history, and it never touches a calendar page you wrote by hand. More
than 200 removals in one run are refused, nothing is removed, and the run is
reported partial; if that many are genuinely gone, run it once with
`GBRAIN_ALLOW_MASS_RECONCILE=1`.

**Say to your agent:** *"re-sync my calendar from scratch"* (your agent runs
`gbrain sync --source <id> --full`).

## Continuous sync

Google sources are ordinary gbrain sources: `gbrain sync --source <id>`,
`gbrain sync --all`, autopilot, and the dream cycle all pick them up. A bare
un-targeted `gbrain sync` (repo mode) does not — target it or use `--all`.
Health: `gbrain google status` (live refresh probe per account) and
`gbrain doctor` (the `google_oauth` check warns once a Testing-mode account
goes 5+ days without a successful refresh — note an account that refreshes
daily gets no pre-warning before Google kills Testing-mode tokens at day 7;
publishing to Production is the real fix). Once you publish the app to
Production, record it by re-running consent —
`gbrain google connect --reauth <email> --consent-state production` — so the
weekly-expiry warning stops firing. `gbrain google status --account <email>`
shows only that account and the sources that read it. Each account reports its
`client_mode` (`personal`, `byo` or `relay`) and `grant_generation`; a failed
refresh probe makes `ok` false and exits 1, and under `--no-probe` each
account reports `refresh_probe: unprobed`. Less-common flags
(`--via`, `--no-browser`, `--no-probe`, `--purge-client`, and setup's
`--history-days` / `--sync-budget-ms`): `gbrain google --help`. The `--via`
hosted fast path (a verified OAuth client brokering consent, tokens still
stored locally) is feature-gated off until the relay server exists; its full
design lives at
[`docs/designs/HOSTED_OAUTH_RELAY.md`](../designs/HOSTED_OAUTH_RELAY.md).

Sync freshness is honest by construction: the GMAIL sweep's success gates the
source's synced stamp (it protects loop freshness — the thing `gbrain
waiting`'s staleness gate exists to guard); contacts/calendar failures mark
the run partial without blocking it. Current mail comes first: each sync
drains the history delta (and any gap left by an expired history token)
before it continues the historical backfill, and the source is fresh once the
delta is drained, no gap is open and the last 14 days are imported, while the
deep backfill carries on. A thread that keeps failing is held (see
[Held items](#held-items)) instead of wedging the sync. Autopilot keeps a
source synced after its first sync; a source that has never synced stays idle
until you run `gbrain sync --source <id>` once.

### What runs on synced mail and calendar pages

**Say to your agent:** *"Make sure my Gmail threads are checked for open loops
and linked to the people in them"* or *"Also extract atoms from my email and
calendar pages."*

- **Links and timelines.** Every autopilot or dream cycle extracts links and
  timeline entries for connector pages straight from the database (a connector
  source has no checkout), source-scoped and bounded by the cycle's 3-minute
  stale-drain budget; a large backlog finishes over later cycles. The cycle
  reports `extract: ok` with `database_only: true`. On demand:
  `gbrain extract --stale`.
- **Open loops.** Every Gmail sweep queues commitment extraction for the
  threads it touched, on managed and unmanaged brains. The sync result carries
  `loops_enqueue` (`enqueued`, `deferred`, `skipped_reason`), and every skip is
  logged with its reason (extraction off, no chat model, the enqueue ceiling).
  On a managed brain the first sweep also runs a one-time catch-up over email
  threads whose newest message is from the last 30 days, so threads synced
  before extraction was queued are analyzed once; it finishes over later
  sweeps when the enqueue ceiling binds. Threads under a label you listed in
  `g_loops_exclude_labels` (or the brain-wide `loops.extraction_exclude_labels`)
  are never queued and open no deterministic loop; an unknown label name
  fails closed with `excluded_label_unresolved` until you fix it. See
  [open loops](open-loops.md#which-threads-reach-the-extractor).
- **Quiet threads.** A thread still inside its waiting window (24 h for
  inbound, 72 h for your own question) is re-checked when the window ends,
  even if no new mail arrives, and opens its loop then. See
  [open loops](open-loops.md#quiet-threads-and-grace-holds).
- **Atoms (on by default).** Atom extraction covers Gmail threads and Calendar
  events like other pages: the text of each extracted email thread or calendar
  event is sent to the configured `extract_atoms` model under the daily
  auto-drain cap. `gbrain config set cycle.extract_atoms.connector_pages false`
  opts out and stops new extraction. Caps, the off switch and exactly what leaves the machine:
  [spend controls](../operations/spend-controls.md#atom-extraction-auto-drain-cap-and-connector-pages).

`gbrain doctor`'s `orphan_ratio` reports orphaned email and meeting renders of
a connector source apart (`connector_renders_excluded`), since a mail page
with no links is normal, and leaves them out of the ratio.

### Rate limits during backfill

A large mailbox backfilling a wide `--history-days` window can trip Gmail's
per-user rate limit in bursts — Google answers with HTTP 403
(`rateLimitExceeded` / `userRateLimitExceeded`) or 429, and it clears on its
own within seconds to low minutes. The client retries a rate-limited request
patiently — 6 attempts by default, exponential backoff with jitter capped at
60s, honoring `Retry-After` when Google sends one — before finally giving up
and reporting `rate_limited`. That budget is deliberately much larger than
the 2-attempt budget used for other retryable failures (like a 401 needing a
token refresh), so a thread that would succeed a few seconds later is not
skipped for the rest of the sync.

Even when a thread's retry budget IS exhausted, a rate-limit failure is never
counted toward a hold — unlike a genuine per-thread
failure (a malformed message, a permissions edge case), a rate limit says
nothing about that specific thread, so the sweep keeps retrying it on every
future run instead of silently giving up on it.

## Held items

A connector item that fails with an item-scoped error on three consecutive
syncs is **held**: it is recorded in the source's cursor state, and the sync
moves on past it instead of wedging the whole source. A held item is never
skipped silently:

- `gbrain sources status` lists up to 10 held items per source (key, sender and
  subject or title when known, error code, class, first and last failure,
  attempts, next automatic retry), then `+N more; --json lists all`;
- `gbrain doctor` reports a per-source count in the `connector_held_items`
  check;
- the sync summary prints the held count and the retry command;
- for Gmail, `gbrain waiting` returns `completeness: "partial"` and names each
  held thread from the last 14 days (or with an unknown date).

Contacts and Calendar items are held the same way, keyed
`contact:<resource name>` and `event:<calendar id>:<event id>`. One failing
contact or event no longer stops its sweep: the other contacts and events, and
the Gmail sweep, still land. Only a failure that repeats until the item changes
(for example a contact email or event attendee carrying text the brain cannot
store, `invalid_connector_text`) counts toward a hold; a transient failure is
retried on the next sync and never held. While the failing item is not held,
that service's sync token stays where it is, so the next sync lists the item
again; once it is held, the token moves past it. On a managed brain a failed
coordinator write still ends the run, as before, and `--retry-failed`
re-admits it. Because a sync token never lists an
unchanged item again, `gbrain sources retry-held` re-fetches a held contact or
event by its id on the next sync. Contacts and Calendar holds do not change the
coverage `gbrain waiting` reports, which is about mail.

A held item does not block the source's freshness stamp. To re-attempt:

```bash
gbrain sources status <id>          # what is held and why
gbrain sources retry-held <id>      # schedule every held item (add --dry-run to preview)
gbrain sync --source <id>           # run the re-attempt now
gbrain sources status <id>          # a recovered item leaves the list
```

`gbrain sync --source <id> --full` also clears every hold. A held item whose
upstream copy changes is re-attempted once automatically.

**The thresholds are fixed** so every brain behaves the same way and a held
item always means the same thing:

| Rule | Value | Why it is fixed |
| --- | --- | --- |
| Hold after | 3 consecutive attempted syncs that failed for that item, at the same upstream version | Long enough to ride out a flaky run, short enough that one bad item cannot pin the cursor for days |
| Never counted | Rate limits, and source-level errors (auth, config, writer coordination, lock and statement timeouts, database contention) | They say nothing about the item |
| Circuit breaker | A sync with at least 5 attempted items counts nothing when at least half of them failed transiently, or when at least 5 and at least half failed with the same error code | A provider outage must not hold healthy items |
| Transient retry | A held item whose error was transient (5xx, network, unknown) is retried after 1 h, 6 h, 24 h, then daily, for 7 days; after that it stays held like a content error | Recovers on its own from a provider incident |
| Cap | 100 held items per source; a sync that would hold more stops advancing its cursor and fails with `connector_holds_exhausted` | Many held items means something is wrong with the source, not with items |

The overrides are `gbrain sources retry-held <id>` and
`gbrain sync --source <id> --full`. See
[write refusal reasons](write-refusals.md) for `connector_holds_exhausted`,
`invalid_connector_text` and `connector_fence_below_timeline`.

## Other ways to reach Google (no gbrain OAuth)

To give a local agent read-only Google tokens, or Google Workspace writes you
approve, without handing it your refresh token, use the token socket:
[Google token socket](google-socket.md).

If your stack already holds Google access another way — a Google CLI with its
own auth store, `gcloud`, or a credential gateway that can mint short-lived
access tokens — the source can use it directly and skip gbrain's OAuth flow
entirely. `--account` stays required as the IDENTITY (it drives "is this
message mine" loop direction and the Gmail deep links' `authuser`); no
credential is stored in gbrain for these modes.

**Say to your agent:** *"connect my gmail through my existing Google CLI —
your agent runs `gbrain sources add <id> --kind google --access command
--token-command \"<your token command>\" --account <email>`"*

```bash
# Any command that prints an access token (bare token, or JSON with a
# token/access_token field and optional expiry/expires_in). gbrain runs it
# at sync time and caches the token until it expires; it never stores it.
gbrain sources add gmail-work --kind google --account you@example.com \
  --access command --token-command "gcloud auth print-access-token"

# Or read a live token from an env var refreshed by something outside gbrain
# (a gateway sidecar, a cron job). The var NAME goes in config, never a value.
gbrain sources add gmail-work --kind google --account you@example.com \
  --access env --token-env GOOGLE_ACCESS_TOKEN
```

What changes vs the vault flow: `gbrain google status`'s refresh probe and
`gbrain doctor`'s `google_oauth` check cover vault accounts only (your
external tool owns token health); the scope preflight trusts `--services`
(a token missing a scope surfaces per sweep as Google's 403, reported as
`scope_missing`, rather than up front); send-as aliases are fetched live when the token
allows it, otherwise identity degrades to the account address alone. The
token command runs locally at sync time with your shell — it lives in local
source config, is never reachable over MCP, and is the same trust class as a
recipe health-check command. Failures surface as `access_command_failed` /
`access_env_missing` with the fix attached.

### Reading mail through gbrain.io

A brain can read Gmail through a [gbrain.io](https://gbrain.io) terminal
instead of a Google token. gbrain.io keeps the mailbox grant; this machine
runs the `gbrainio` command line, and gbrain reads its JSON answers. gbrain
stores only the command path, never a credential.

```bash
gbrain sources add mail-work --kind google --account you@example.com \
  --access gbrainio --history-days 30 \
  --private-senders-file ~/.gbrain/private-senders.txt   # optional
gbrain sync --source mail-work                        # first sync: the last 30 days
```

It reads Gmail only (no Calendar or Contacts), and it reads by date window:
each sync lists mail from an hour before the newest message it has, so new
mail and replies land and a thread that did not change is never fetched
again. The first sync fills `--history-days`, newest mail first, and
resumes where it stopped if it runs out of time. `--gbrainio-command` sets a
full path when `gbrainio` is not on `PATH`.

Ingest tiers are on by default only for gbrain.io sources. For any Gmail
source, pass `--ingest-tiers` or `--no-ingest-tiers` to `gbrain sources add`
to override the default. Choose when you add the source because the setting
is part of its connector identity.

```bash
gbrain sources add mail-personal --kind google --account you@example.com \
  --access vault --services gmail --ingest-tiers
```

When ingest tiers are on, gbrain sorts threads before it writes any pages:

| Tier | Which threads | What gbrain does |
|---|---|---|
| `full` | You wrote in it, a message is starred or important, or someone in it has a person page | A normal email page |
| `record` | Other mail that is not bulk | A searchable page with `facts_backstop: false`, `extract_atoms: false` and `conversation_parseable: false`; no model reads it |
| none | You never wrote and every other message is bulk (promotions, social and forum categories, mail gbrain.io marks automated, noise senders, mail to more than five people from a sender with no person page) | No page |
| `private` | Someone in it is on the private-senders list | An owner-only page (`visibility: private`), embedded like other private pages, never read by a model |

The private-senders file holds one address or `@domain` per line (`#` starts
a comment). If the file is missing, unreadable or empty, the sync stops before
writing anything. When you add someone, the next sync rewrites their existing
pages as private (up to 200 threads per sync; the rest follow on later syncs);
on a git-backed brain, earlier commits still hold the old text. A page whose
thread is gone from Gmail is never deleted for that: it keeps its tier, the
sync log names it and retries it, and `gbrain delete <slug>` removes it. Otherwise a thread's tier is set when
its newest message is read: starring it or creating a person page later
changes the tier only when a new message arrives.

What is not available on a gbrain.io source: `--full` skips the delete scan
(pages of mail deleted later stay), `gbrain google attachments` repair is
refused (`gbrainio_unsupported`), and labels you made yourself are not seen,
so `g_loops_exclude_labels` matches only the built-in categories. A gbrain.io
usage limit is handled like a Google rate limit: the unread range stays open
and the next sync resumes it. Every mail answer must name the account the
source was added for; an answer that names another account, or none, is
refused (`gbrainio_account_mismatch`).

## Troubleshooting

Every failure the connector can hit maps to a typed error with the fix
attached. The catalog (also emitted as structured JSON with `--json`):

| Code | What happened | Fix |
|---|---|---|
| `client_json_wrong_type` | The downloaded JSON is a **Web application** client (top-level `"web"` key) | Create a **Desktop app** client and download its JSON |
| `client_json_unreadable` | The client JSON path doesn't exist or isn't the Google Cloud download | Re-download from Credentials → your Desktop app client → Download JSON, pass with `--client-json <path>` |
| `client_shape_invalid` | Pasted ID/secret malformed (smart quotes, truncation) | Re-copy, or use `--client-json` |
| `redirect_uri_mismatch` | Google rejected the redirect | Almost always a Web-type client — use a Desktop app client |
| `access_denied_test_user` | Consent blocked (External + Testing, you're not a test user — or you clicked Cancel) | Add yourself under Audience → Test users, retry the same URL |
| `pasted_wrong_url` | You pasted the consent-page URL | Approve first, then paste the `http://127.0.0.1...` address-bar URL |
| `state_mismatch` | The paste came from an older attempt | Re-run connect, use the fresh URL |
| `admin_policy_enforced` | Workspace admin blocks third-party apps (even your own client) | Admin console → Security → API controls → trust the app; or make the consent screen Internal |
| `wrong_account_consented` | A different Google account approved | Re-run; the URL now pre-selects the right account |
| `port_in_use` | Loopback port taken | Re-run (fresh ephemeral port), `--port <n>`, or `--paste` |
| `consent_timeout` | Consent never completed within 10 minutes | Re-run connect |
| `invalid_grant_testing_expiry` | Refresh token dead ≈7 days after connect | Publish the app to Production, then `gbrain google connect --reauth <email>` |
| `invalid_grant_revoked` | Access revoked (password change, manual revoke, client rotated) | `gbrain google connect --reauth <email>` |
| `invalid_grant_clock_skew` | Your system clock is off by >60s | Fix time sync, retry |
| `code_reused` | Authorization code used twice | Re-run connect (codes are single-use) |
| `invalid_client` | Client secret rotated/deleted in the console | Download the current JSON, reconnect |
| `no_refresh_token` | Google returned no refresh token | Re-run connect; if persistent, revoke at <https://myaccount.google.com/permissions> and reconnect |
| `api_not_enabled` | An API isn't enabled in your project | The error carries the project and the enable link from Google's error; `gbrain google status` names every disabled API at once (see [API access](#api-access)) |
| `rate_limited` | Google quota hit | Automatic backoff; nothing to do |
| `scope_missing` | Connected with narrower `--scopes` than needed, or Google answered a request with "insufficient authentication scopes" | `gbrain google connect --reauth <email>` |
| `relay_unreachable` / `relay_session_expired` / `claim_already_used` / `relay_disabled` | Hosted fast-path (gbrain.io relay) issues | BYO connect always works: `gbrain google connect` |
| `not_connected` | No vault entry for the account | `gbrain google connect` |
| `personal_account_required` | `--personal` without `--account` | Add `--account <email>`: each Personal-mode client is bound to one account |
| `client_user_mismatch` | A Personal-mode client was used by an account other than the one that created it | Open the Personal-mode link signed in as that account and use its own client |
| `client_record_mismatch` | The client that minted the account's tokens is no longer on file | `gbrain google connect --reauth <email>` (or `--personal --account <email>`) |
| `client_swap_refused` | A new client was not saved because its consent did not finish | Finish the consent; the previous client and grant are untouched |
| `identity_unproven` | Google's answer did not prove the account (bad ID token, userinfo failed, or another account) | Check `--account` and that `openid email` were granted; nothing was written |
| `write_scope_refused` | Google returned a token that can change data; gbrain only stores read-only tokens | `gbrain google connect --reauth <email>` (asks for read-only scopes only) |
| `import_invalid` | `connect --import -` input is missing or malformed | Fix the named field; nothing was written |
| `vault_lock_busy` | Another gbrain process holds the vault lock; gbrain never writes without it | Retry in a few seconds; look for a stuck gbrain process |
| `vault_generation_changed` | The account was reconnected or disconnected while a token write was in flight; the stale write was dropped | Nothing to do; retry |
| `refresh_lease_busy` | Another process is refreshing the same grant | Retry in a few seconds |
| `calendar_unreadable` | Google answered the source's calendar read with HTTP 403 or 404: the account cannot read that calendar | `gbrain google calendars --account <email>`, then `gbrain sources set-calendar <source> <calendar-id>`; see [Unreadable calendar](#unreadable-calendar) |
| `upstream` | Google returned an unexpected error | Retry; if it persists, run `gbrain google status --json` and file the output |
| `access_command_failed` | The `--access command` token command exited non-zero, timed out, or printed nothing token-shaped | Run it by hand; it must print a bare token or JSON with `token`/`access_token` |
| `access_env_missing` | The `--access env` variable is unset/blank in this process | Export a live token into it (refresh externally), or switch back to the vault flow |
| `gbrainio_not_connected` | The gbrain.io terminal ended, was never approved, or cannot read this mailbox | `gbrainio terminal show`; approve or extend it on gbrain.io with mail at Read on the account |
| `gbrainio_limit_reached` | gbrain.io's usage allowance is used up | Nothing is lost; the next sync resumes. Sync less often, or check the Limits tab on gbrain.io |
| `gbrainio_account_mismatch` | A gbrain.io answer named a different mailbox than the source | Check `--account` on the source and the account the terminal reads |
| `gbrainio_command_missing` | The `gbrainio` command is not installed or not on `PATH` | Install the gbrain.io terminal client, or set `--gbrainio-command /full/path` |
| `gbrainio_command_failed` | A `gbrainio` read failed or printed something gbrain could not read | Run the same `gbrainio tool gmail ...` command by hand; the range stays open for the next sync |
| `gbrainio_unsupported` | A step that needs a Google token (attachment repair, the change feed) on a gbrain.io source | Nothing to fix; use a vault-connected source for that step |
| `private_senders_unreadable` | The source's private-senders file is missing, unreadable or empty | Restore the file (one address or `@domain` per line), or remove the setting |

Cursor expiries (`historyId` older than ~a week, calendar/contacts
`syncToken` 410, or a contacts HTTP 400 explicitly reporting an expired sync
token) use bounded re-lists automatically. Contacts recovery refreshes its
own cursor without restarting Gmail. A full contacts list (first sync or an
expired token) saves its page cursor after each page and lists at most 10
pages (2,000 contacts) per sync, so a large address book finishes over
several syncs, each resuming where the last stopped, while Calendar and Gmail
still run every time. `--full` lists every page from page 1 in one run. A contact that keeps failing does not hold the
list back: the cursor moves past its page, and once the list ends the next
sync starts it again from page 1 without saving a sync token, so the contact
is retried. A contacts HTTP 400 on a sync-token request that
is not an expiry (a token minted under other request parameters) gets one
full-list attempt, and a saved page cursor Google no longer accepts (HTTP 400
or 410, the 400 naming the page token) restarts the list from page 1 once;
every other HTTP 400 remains an
upstream failure rather than triggering a re-list.

## Custody, privacy, spend

- Tokens: local vault only, 0600, atomic writes. `sources.config` stores an
  account *pointer*, never a secret. `gbrain creds list` is always redacted.
- Every stored access token is read-only, checked against Google's own answer
  (the token response's scopes, or tokeninfo) before it is written.
- Vault writes take a short lock and fail closed (`vault_lock_busy`) rather
  than write unlocked; only a lock whose process is gone is taken over. Each
  account's grant carries a generation that every consent, reconnect and
  import bumps, and a token write lands only on the generation it read, so a
  refresh that races a disconnect or reconnect can never write the old grant
  back. Refreshes of one grant are serialized across processes.
- Mail, calendar and contact pages and the sync state: 0600 files in 0700
  directories gbrain creates. See [File permissions](#file-permissions).
- Sign-in codes and links in mail: off by default, so Gmail bodies are stored
  as they arrive. `gbrain config set google.gmail.redact_credentials true`
  makes every Gmail sync replace labelled one-time codes, sign-in, reset and
  verify links that carry a token, credential-shaped strings and labelled
  passwords with `[redacted:otp]`, `[redacted:login-link]`,
  `[redacted:credential]` or `[redacted:password]` before the text is stored,
  chunked or indexed, on every later sync of the thread too. A page stored
  before you turned it on keeps its text until its thread syncs again, and
  older page versions keep theirs. Unlabelled numbers and ordinary links are
  left alone, so a code with no label next to it is not caught.
- Disconnect: `gbrain google disconnect <email>` removes local tokens; revoke
  Google-side at <https://myaccount.google.com/permissions>.
- Upgrade/transfer: `gbrain creds export` produces a passphrase-encrypted
  bundle (a loud per-credential warning when a Testing-mode consent screen
  would travel with it — those tokens die within 7 days on the target).
- LLM spend: commitment extraction sends recent email text (last 30 days,
  capped per sweep) to your configured chat provider, under a daily cap of
  $2.00 (`loops.extraction_max_usd_per_day`; see
  [open loops](open-loops.md#which-threads-reach-the-extractor)). Kill switch:
  `gbrain config set loops.extraction_enabled false`. The deterministic
  unanswered-thread detector is free and always on.
- Atom extraction from email and calendar pages is on by default: page text
  goes to the `extract_atoms` model under the auto-drain cap. Opt out with
  `gbrain config set cycle.extract_atoms.connector_pages false`
  ([spend controls](../operations/spend-controls.md#atom-extraction-auto-drain-cap-and-connector-pages)).

## File permissions

A Google source keeps its files in one directory: by default
`~/.gbrain/clones/<source-id>-google`, or the directory you passed with
`gbrain sources add <id> --kind google --account <email> --dir <path>`. gbrain
writes these files there:

- `.google-source.json`, the sync cursors (and `.google-source.json.corrupt`
  if a damaged state file was set aside),
- one Markdown page per email thread under `emails/`, per event under
  `calendar/` and per contact under `people/`.

Each of those files is written with mode 0600 (readable only by you).
Directories gbrain creates for the source, including the source directory
itself when it does not exist yet, are created 0700. A directory that
already exists, such as one you chose with `--dir`, is never chmod-ed. The
same modes apply when managed persistence publishes the pages. On Windows
gbrain does not set modes.

**gbrain enforces 0600.** Every time gbrain rewrites one of these files it
sets 0600 again, so a looser mode you set by hand (for example
`chmod 644` to share a page with a group) is reverted on the next rewrite.
Pages that did not change are not rewritten and keep whatever mode they have.
This is deliberate: the pages are your private mail, calendar and contacts,
and a page that quietly stays group-readable after a sync is the failure
this rule prevents. There is no per-source setting for a looser mode yet.

### Files readable by other local users

gbrain releases before v0.60.31.0 wrote these files with your umask, typically
0644 (readable by every local user), and an upgrade does not rewrite them. In
the default directory that is harmless, because gbrain keeps `~/.gbrain` at
0700. In a custom `--dir` outside `~/.gbrain`, those pages stay readable by
other local users until they are rewritten.

The upgrade prints a one-time notice for each Google source outside
`~/.gbrain`, naming the directory, how many readable entries it found and
the repair commands. `gbrain doctor` checks the same thing on every run:

```text
  [WARN] google_file_modes: Google source gmail-you: 412 file(s) and 9 directories gbrain wrote under /data/mail are readable by other local users (written before this release). Preview: gbrain repair google-file-modes --source gmail-you — apply after the user agrees: gbrain repair google-file-modes --source gmail-you --apply
```

The check reports counts per directory, never file names (Gmail page names
contain subject words). `gbrain doctor --json` carries `source_id`, `dir`,
`loose_files`, `loose_dirs` and both commands under `details.sources`.

**Fix it with gbrain (recommended):**

```bash
gbrain repair google-file-modes --source <id>          # preview: counts and up to 10 sample paths
gbrain repair google-file-modes --source <id> --apply  # clear group and other permission bits
```

The repair only touches gbrain's own layout: `.google-source.json*`, the
pages gbrain recorded for that source under `emails/`, `calendar/` and
`people/` (and their leftover `.tmp` files), and the directories between the
source directory and those pages. It clears the group and other bits and
keeps your own. It never changes the source directory itself, never follows
a symlink, and skips files owned by another user (counted as residuals).
Without `--source` it covers every Google source outside `~/.gbrain`. The
preview's sample paths are relative to the source directory, so they can
show subject words; run it on the brain host. See
[`gbrain repair`](repair.md#what-each-kind-fixes).

**Or fix it with chmod.** If the directory holds only this source:

```bash
chmod -R go-rwx /path/to/google/dir
```

If the directory also holds other files you want to keep shared, limit the
change to gbrain's files:

```bash
DIR=/path/to/google/dir
chmod go-rwx "$DIR"/.google-source.json*
chmod -R go-rwx "$DIR"/emails "$DIR"/calendar "$DIR"/people
```

**Verify:**

```bash
find /path/to/google/dir \( -perm -040 -o -perm -004 \) -print | head   # prints nothing
gbrain doctor   # [OK] google_file_modes
```

### Related messages

- `[google] could not secure the quarantined state file <path>: <chmod|rename> failed (<error>). It may be readable by other local users; run chmod 600 <path> or delete it.`
  A damaged state file was set aside, but gbrain could not make the copy
  private. The sync continues from empty cursors. Run the printed `chmod` or
  delete the file.
- `Stale temporary path <path>.tmp is a directory; remove it and re-run the sync.`
  A directory sits where gbrain writes a page's temporary file. That item
  fails until you remove the directory.

## For agents ([SHOW USER] protocol)

Every `gbrain google`/`creds`/`waiting` command supports `--json` and emits
`{ ok, status, next_action: { command?, user_message? }, error? }`. Human
copy the harness should relay verbatim is fenced in `[SHOW USER]` blocks.
The whole setup is exactly two user interactions: (1) the GCP checklist +
client JSON hand-back, (2) one consent click. Never pass secrets via argv —
use `--client-json <path>`, stdin, or env.

**Exit codes (contract v1 legacy).** `gbrain google` exits 0 when done, 1 when
it failed, and 2 both for usage errors and when it is waiting on the user (for
example `status: "awaiting_consent"` after printing the consent URL, or
`status: "no_brain"`). Other gbrain commands use exit 3 for "the user must agree
first"; `google` keeps 2 under contract v1 and moves to 3 in a future contract
version. Branch on the JSON `status`, not on exit 2 alone. `next_action` is the
legacy name for `fix` ([legacy advice names](../protocol/AGENT_OPERATOR_v1.md#legacy-advice-names)).

## Attachment receipts and historical repair

Gmail attachment receipts record filenames, MIME types, byte sizes when supplied,
account/message/part identity, and Gmail attachment IDs when available. They do
**not** download attachments or index their contents. Calendar documents and
inline parts are distinguished from ordinary documents; plain/HTML message-body
parts are not attachment receipts. Receipt metadata inherits its message page's
source and visibility. Filenames are inert data, not paths or executable links.

Message rendering distinguishes four states:

- **Not inspected:** a legacy message has no inspection receipt. Absence of a
  receipt says nothing about whether an attachment exists.
- **Inspection incomplete:** missing/malformed MIME data or a safety bound stopped
  inspection. Any receipts already observed remain visible, but absence is unknown.
- **Inspected; none found:** bounded inspection completed without attachments.
- **Present; not downloaded; not indexed:** metadata exists, but attachment content
  is not available to search. For example, `fixture.pdf — application/pdf; 17 bytes`.

Each message MIME walk is iterative, capped at depth 32 and 512 visited parts.
Attachment receipt payloads have a 64 KiB aggregate budget per fetched thread;
over-limit metadata is incomplete rather than silently marked empty. Missing part
IDs use deterministic MIME paths. Duplicate filenames remain separate receipts.
Missing message IDs have deterministic fallback identities but no invented Gmail
link. Pure-noise threads remain excluded by the existing ingestion policy.

Historical repair requests a Gmail partial response containing message IDs and
explicit MIME metadata fields; `body.data`, raw messages and snippets are never
selected. The selection includes child-identity sentinels beyond depth 32 so a
deeper MIME tree remains incomplete rather than appearing empty. Decoded metadata
responses are capped at 2 MiB before JSON parsing; oversized responses fail without
advancing repair. Ordinary sync fetches message bodies; only historical repair
uses this metadata-only request.

Sync records receipts for threads it ingests; it does **not** revisit every
historical page. Ordinary incremental sync only revisits changed threads and its success does not establish
historical inspection. To repair already-imported pages without replaying bodies:

```sh
gbrain google attachments backfill --brain host --source gmail-example --json
gbrain google attachments backfill --brain host --source gmail-example --yes --limit 25 --json
```

This is a trusted **local, managed-persistence-only** command for both PGLite and
PostgreSQL. Use an existing Google source and existing CLI writer registration on
the selected canonical host. It never enables persistence, installs services, or
silently registers a new repair writer. Keep old conflicting mutation workers
quiesced without deleting their queued work. For PGLite, stop its resident owner
cleanly first: this command does not delegate historical repair to a running owner.
For PostgreSQL, use the configured host brain or an explicitly selected local
PostgreSQL mount; source selection never switches the database. Unmanaged sources
can continue ordinary ingestion, but this historical repair refuses them.

The first command is read-only and makes no Google calls. Its `status: "preview"`
names the effective brain, source, account, imported-page count and saved historical
cursor (or `not_inspected`). Review that scope before applying `--yes`. The apply
command processes at most 25 imported thread pages, patches only the
`gmail_attachment_receipts` frontmatter field, and preserves current body, other
frontmatter, tags, visibility and committed withdrawals. It never calls loop/fact
extraction or an attachment-download/model API. Canonical text projections are
rebuilt without provider calls; receipt filenames are not extracted as facts.

A batch returning `status: "paused", complete: false` exits nonzero with its
durable count and cursor. Repeat the **same command** to resume. The per-account
cursor is checkpointed only after committed page receipts; interruption can repeat
a page safely without duplicating receipt identities. `status: "complete"` means
traversal of the fixed upper page-ID boundary captured at the first repair invocation
is done, **not that every message was inspected or mailbox-wide coverage**.
`inspected` counts fully inspected pages; `unavailable` counts pages with missing
historical messages, and `unavailableMessages` counts those identities separately.
`inspection_complete` is false when traversal is paused or any identity is unavailable.
This scan has no date filter and does not import
missing/deleted pages; new ingestion handles newly imported pages.

A confirmed Gmail thread HTTP 404 or a missing historical message ID in an otherwise
valid thread records `messages[].unavailable` (`thread_not_found` or
`message_not_found`). Any prior receipt and inspection metadata stays intact; an
identity without prior metadata has `inspection.state: not_inspected`, not `none`.
The historical body, privacy and message IDs remain unchanged. The durable cursor
can then continue to later pages without repeatedly blocking on upstream absence.
Authorization/rate-limit errors, malformed responses, other HTTP errors and unknown
ownership are not disappearance and do not authorize skipping the affected page.

`incomplete` also exits nonzero and leaves the cursor before that page. A conflict
(unknown receipt ownership, canonical edit during publication, delete/recreation,
source/account change or lost lease) preserves existing content and stops progress.
Inspect the retained write receipt and source before retrying. After resolving a
terminal failed receipt, `--yes --retry-failed` explicitly authorizes its linked
retry; never reset cursors, force overwrite, or restore an old backup to bypass a
withdrawal. Completed partial work remains durable. Provider failure, unavailable
owners and malformed metadata are not successful inspection.

Verify with the preview command above and an authorized page read:

```sh
gbrain get emails/2026/09/example-thread --brain host --source gmail-example
```

Inspect `frontmatter.gmail_attachment_receipts.messages[].inspection` for the
individual states and preserved attachment identities. The page's existing Gmail
citation remains its navigation link; a missing message ID reports unavailable.
Private pages and their receipts remain unavailable to unauthorized remote readers.
