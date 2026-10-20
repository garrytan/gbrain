# Connecting Apple (Calendar, Contacts, Mail on macOS)

gbrain's apple connector ingests your Mac's Calendar events, Contacts and eligible Mail
threads into your brain as pages, the same way the [google connector](google-connect.md)
does for Google accounts. It reads data already on your Mac, but Mail accounts hosted by Google
(Gmail and Google Workspace) are **excluded from Apple Mail** and read only through the Google
connector.

It is **read-only** toward Apple, holds **no credentials**, and works **only on
macOS 14 (Sonoma) or newer with Xcode Command Line Tools 15 or newer**
(`xcode-select --install`). On an older macOS or toolchain the Calendar and
Contacts helpers fail to compile; gbrain reports that as `macos_too_old` with
the fix instead of a compiler error. Each of the three services is opt-in per
service, and **Mail is never on by default**.

> The helpers have not been run against real Calendar, Contacts or Mail data by
> the people who wrote them: they compile and are tested against fakes. Treat the
> first sync on a real Mac as the first real test, and read the pages it writes.

## The fast path (one command)

```bash
gbrain apple setup
```

`setup` is idempotent (re-running is always safe) and walks the chain:

1. resolves the effective source and privacy scope, then confirms **Mail** with you (it is the most sensitive service; see
   [Mail confirmation](#mail-confirmation)), including the exclusion of Google-hosted accounts,
2. probes each selected service for the macOS permission it needs. A service
   macOS has **not asked about yet** (`permission_not_determined`, not a denial)
   gets its prompt: when you run setup in a terminal (or pass `--yes`) gbrain
   asks macOS once and re-probes, so click **Allow** when the dialog appears. With
   no terminal attached, setup prints a message that a prompt will appear on the
   Mac's screen and exits 2,
3. if one is denied, prints the exact System Settings pane to fix and stops
   (exit 2) so you can grant it and re-run,
4. registers the source (once), and
5. runs a first sync under a wall-clock budget (`--sync-budget-ms`, default
   90 s); whatever did not fit resumes on every later sync. `--no-sync` skips it.

```bash
gbrain apple setup --services calendar,contacts      # opt Mail out
gbrain apple setup --yes                             # all three, Mail confirmed
gbrain apple status                                  # live per-service probe, last sync, held items
gbrain apple status --no-probe                       # no helper runs; last recorded probe
gbrain apple services                                # which services are enabled
gbrain sources set-services apple-local --remove mail
```

Every subcommand accepts `--json` and emits the same envelope as `gbrain google`:
`{ ok, status, next_action: { command?, user_message? }, error?: { code, problem, cause, fix, doc_url } }`.
Exit codes: **0** done, **1** failed, **2** waiting on you (a permission, or the
Mail confirmation).

The pieces, if you want them separately:

```bash
gbrain sources add apple-local --kind apple --services calendar,contacts
gbrain sync --source apple-local
```

## Choosing services (opt-out)

`--services` takes any subset of `calendar,contacts,mail`. `gbrain apple setup`
without `--services` selects all three and then asks you to confirm Mail;
`gbrain sources add --kind apple` without `--services` enables **calendar and
contacts only**. Including Mail needs `mail` in `--services` **and**
`--confirm-mail` (error `mail_confirmation_required` otherwise).
An unknown or empty value is an error (`unknown_service` / `empty_services`);
it is never widened to "everything", because Mail and Contacts are private data.

### Google Mail account routing

When Mail is selected, setup and each Mail sync read only Mail's **public account metadata**: account id,
server name, account type and enabled state. They never read account passwords, user names, email addresses
or full names. A Google address is not used as a provider signal: the decision is based on Mail's configured
receiving server, so a `gmail.com` address hosted elsewhere is not assumed to be Google and Google Workspace
on a custom domain is still excluded when its receiving server is Gmail's.

The documented Gmail receiving hosts are `imap.gmail.com`, `imap.googlemail.com`, `pop.gmail.com` and
`pop.googlemail.com`. Enabled accounts on these hosts are excluded from Apple Mail; connect them with
`gbrain google setup`. Other enabled accounts are read one account at a time. Apple Mail's unified Inbox and
Sent mailboxes are never used, because they can mix all accounts. The default `INBOX,Sent` mailboxes are
resolved separately in every Apple-eligible account. A missing or ambiguous localized Sent mailbox is an
explicit `selection_not_found` / `selection_ambiguous` error; gbrain does not guess which folder is meant.

An enabled account with an unreadable account id, enabled state, server name, malformed/Google-like but
undocumented host, or unsupported account type makes provider routing unknown. **The entire Mail read stops
before reading any Mail, rather than risk importing Google mail.** Setup will not register or sync that source;
an ordinary sync reports `mail_routing_unknown` for Mail while Calendar and Contacts can still run. Fix or
disable that account in Mail, or opt Mail out with `gbrain sources set-services <source> --remove mail`.
If all enabled accounts are Google-hosted, Apple Mail reads nothing: setup waits for `gbrain google setup`;
Calendar and Contacts can still be connected separately.

The Mail cursor is bound to a fingerprint of the eligible account ids, normalized hosts and account types. A
provider change under the same account id is a scope change: the next read starts over from the configured
window, not a stale cursor. Recovered Mail text staged under the previous account scope is dropped. Account
routing changes never delete or replace stored Mail pages, never clear a hold because a message was filtered,
and never claim Mail coverage for Google messages Apple did not read.

When account routing is first introduced to an existing Apple Mail source, its old pages have no saved owner-account
id: their provider can no longer be proved. They and the old hashes/holds remain. A later `--full` keeps **all**
Mail pages that are no longer listed, even if mass-reconcile is enabled: not listed under the new provider filter is
not evidence that the message was deleted. Explicit cleanup is not automatic; remove legacy pages only after you
have reviewed and approved that cleanup. New pages written under a known, unchanged routed scope can still be
reconciled normally by `--full` until a routing change makes their origin unknown.

Change them later with `gbrain sources set-services <source> --add|--remove <service>`
(`--add mail` also needs `--confirm-mail`).
**Removing a service never deletes pages**: the ones already imported stay, they
are simply no longer updated. A disabled service is not read at all (its helper
never runs and its permission is never requested). On a managed brain the
change starts a fresh sync cursor for the source and asks for `--yes` first.

## Source options

| Flag | Default | Meaning |
|---|---|---|
| `--services` | `calendar,contacts` (`sources add`); all three after confirmation (`apple setup`) | which services to sync |
| `--confirm-mail` | off | consent to read Mail; required when `mail` is in `--services` |
| `--account <label>` | `local` | a free label for this Mac's account; **not a credential** |
| `--history-days <n>` | 90 (max 3650) | calendar events this far back |
| `--future-days <n>` | 60 (max 3650) | calendar events this far ahead |
| `--calendar-ids <a,b>` | all calendars | only these calendars |
| `--contacts-dir <dir>` | `people` | where contact pages go (relative, lower-case segments) |
| `--mail-mailboxes <a,b>` | `INBOX,Sent` | which mailboxes |
| `--mail-days <n>` | 30 (max 365) | mail this far back |
| `--mail-owner-addresses <a,b>` | none | your own addresses; **required** for unanswered-mail tracking (see [Open loops](#open-loops-unanswered-mail)) |
| `--consent-loops-extraction` | off | consent to send Mail thread text to the chat provider for commitment/decision extraction |
| `a_mail_max` (config key) | 500 (max 5000) | messages read per run; a larger backlog is read over several runs |
| `--dir <path>` | `~/.gbrain/clones/<id>-apple` | the managed directory |

Registering on a non-macOS host prints a warning but works (so a CI or
sync-only host can hold the registration); a sync there reports
`unsupported_platform`.

## Permissions

macOS asks the **app that runs gbrain** (Terminal, iTerm, or whatever launches
the daemon/autopilot) for each service separately. gbrain cannot grant them; it
only probes and tells you where to go. The panes below follow documented macOS
behavior and have not been verified against a live prompt on every macOS version.

| Service | Where | What to enable |
|---|---|---|
| Calendar | System Settings > Privacy & Security > **Calendars** (or Full Calendar Access) | the app that runs gbrain |
| Contacts | System Settings > Privacy & Security > **Contacts** | the app that runs gbrain |
| Mail | System Settings > Privacy & Security > **Automation** | the "Mail" switch under the app that runs gbrain |

If the app is not listed, run the command once from that app in an interactive
session so macOS can prompt. "Interactive" means stdin and stdout are the
terminal: piping setup through `tee` or capturing its output makes gbrain treat
the run as unattended and it will not ask macOS (pass `--yes` to ask anyway). **Unattended runs (autopilot, a daemon, cron) cannot
show those prompts**: grant each service by running `gbrain apple setup` or
`gbrain sync --source <id>` once from a terminal on the Mac, then unattended
syncs work. A denial recorded by a sync is stored with the source's state, so
`gbrain doctor` (`apple_permissions`) and `gbrain apple status --no-probe` show it. If you previously denied it, `tccutil reset
Calendar` / `tccutil reset AddressBook` (all apps) clears the decision; for Mail,
remove the app from the Automation list and retry. Mail also needs Mail.app to
be **running** with at least one account configured and finished loading; gbrain
never launches Mail itself, on a probe or on a sync (it checks `running()` first
and reports `mail_not_running_or_unconfigured`).

`gbrain doctor` has an `apple_permissions` check: zero helper runs, it reads the
last probe each sync recorded and warns when an enabled service was denied.

### Mail confirmation

Because Mail is the most sensitive service, `setup` refuses to touch it without
an explicit `--confirm-mail` (or `--yes`) and exits 2 with `awaiting_confirmation`
and the exact command to run. The confirmation message states what is read
(subject, sender, recipients, date and plain-text body of recent messages from the
configured mailboxes), that attachments are never downloaded, and that Gmail / Google Workspace mail is not read here and must use the Google connector. Opting Mail out
(`--services calendar,contacts`) needs no confirmation.

An explicit `--source` takes precedence over account labels. Without it, duplicate
account labels are refused (`ambiguous_source`). Setup inherits omitted selectors
from the selected existing source, discloses its actual Mail mailboxes/window,
and refuses **any explicit selector difference** (`source_scope_mismatch`;
`service_scope_mismatch` for services) before a probe or sync. This includes
calendar ids/windows, contacts directory, Mail mailboxes/days, owner addresses and
extraction consent. Change an existing source explicitly with its configuration
commands (`apple loops` for owner addresses/consent), or choose a new source id. `--revoke-loops-extraction` is refused on setup rather than silently ignored; use the `apple loops` subcommand.
Confirmation and permission-retry commands preserve selectors, quoting, consent
flags, sync budget and `--no-sync`. A configuration change during probes refuses
execution (`source_scope_changed`) and requires confirming the current scope.

## What the pages look like

- **Calendar** (`type: meeting`): `calendar/YYYY/MM/YYYY-MM-DD-<title>-<id8>.md`
  with start/end, location, attendees and notes. Cancelled events render nothing.
- **Contacts** (`type: person`): `<contacts-dir>/<name>.md` with emails, phones
  and groups. A contact with no name, email or phone renders nothing.
- **Mail** (`type: email`): one page per thread, `emails/YYYY/MM/YYYY-MM-DD-<subject>-<id8>.md`,
  messages in date order, bodies inside a fenced quote (they are untrusted data
  and are never interpreted). Pure automated mail (every message from a
  no-reply/notification sender) renders nothing, as in the google connector.

An incremental sync never deletes: a vanished event, contact or thread keeps its
page. `gbrain sync --source <id> --full` reconciles upstream deletions. It
refuses (the run is `partial`, nothing is deleted) when the reader's listing is
empty but pages exist for that service, when more than 200 removals are due, or
when the listing is known to be short (a mail run cut off at `a_mail_max`, a
message Mail could not read), unless `GBRAIN_ALLOW_MASS_RECONCILE=1` for the
first two. A configured calendar id or mailbox that matches nothing is an error
(`selection_not_found`), not an empty listing. An identical re-run adds and
modifies nothing.

Mail reads are incremental: after the first run only messages since two days
before the newest one already seen are read (`--full` re-reads the whole
`--mail-days` window), capped per run by `a_mail_max`. Message bodies are read in small batches under
a 45-second budget, because Mail.app can take 20 seconds to produce the plain text of one HTML
newsletter (seen on a real Mac): when the budget runs out the run is `partial`, keeps what it read
(oldest first) and the next `gbrain sync` continues from there, so a slow mailbox drains over a few
runs instead of timing out. The helper plans against the real 120-second helper timeout, not just the
45-second budget: a batch only starts if its projected end (20 seconds per body, or the slowest body seen
so far) fits, so a slow Mail start-up shrinks or skips the body reads instead of overrunning. This is a
soft plan, not a guarantee: macOS runs each Mail scripting call synchronously and it cannot be interrupted,
so one single call that is itself slower than the time left (or a slow start-up before any body is read)
is only stopped by the hard `helper_timeout` kill. If one batch cannot be read, its messages are retried
one by one while time allows; a message that still cannot be read (or whose body comes back missing, or
that vanishes mid-read) keeps its thread unavailable and the cursor does not move past it, so it is
retried next run, never imported as an empty body.

**A message that stays unreadable is held, like a Gmail thread.** Only a message the helper *proved*
unreadable on its own (a single-message read that failed, or a body that came back missing) counts: a batch
neighbour that was merely not retried in time, a message that vanished mid-read, an unattributable message, a
permission or automation error, a helper timeout and a budget stop are never holds and keep pinning the cursor
exactly as before. Three runs that each attempted the same message and failed hold it (the same threshold, hold
storage, `gbrain sources retry-held`, doctor check and `gbrain sources status` listing as Gmail). Until then
those runs keep the cursor where it was, and healthy messages around the poison still import. From the next run
on the held message is excluded from the read (it costs no body time and cannot starve its neighbours), the
cursor and later mail move on, and:

- its thread stays **live**: a full walk never removes the page of a thread that still has a held message, and
  the thread page simply lacks the message until it is read again;
- Mail open-loop coverage stays **incomplete** (`gbrain waiting` reports it) until the message is actually read
  again, however old it is and even though the cursor has moved on;
- `gbrain sources retry-held <id>`, a due transient reconsideration (1 h, 6 h, 24 h, then daily for 7 days) and
  `gbrain sync --full` re-read the message **by its stable id and received date**, wherever it is, so a held
  message older than the incremental two-day overlap is still reachable. A read that succeeds merges the message
  into its thread page and clears the hold; one that fails again stays held without pinning the cursor; a
  message deleted upstream is dropped. A failed or timed-out retry read is a source error: it counts nothing;
- a thread whose page *import* is held (3 failed runs) no longer pins the cursor either, and is rebuilt only from
  **complete** evidence. Up to 100 messages it remembers the `(id, date)` of every message it was built from
  (the union of what it remembered and what each run lists, so a growing thread never keeps a stale shorter
  list); a retry reads them by id and renders the thread once every message is read, proven unreadable (its own
  message hold carries it) or gone upstream. A slow Mail.app hands the helper only a few bodies per call (3 were
  observed) and always the oldest, so what a run reads is **kept**: the messages read by id accumulate across
  runs in a bounded staging inside the same cursor state (`mail_recovery`; saved by the same checkpoint write as
  the holds, never a side file, never logged, never sent to a model, dropped with the hold). Each call asks only for
  what is still unresolved, in whole-thread packs sized to what the helper has been seen to resolve; at most 4
  calls per run, and a call that resolves nothing ends the run's reads. Nothing is rendered or cleared from
  partial evidence: the hold, its counters and the retry request stay as they were (a budget stop is not a
  failure and is never counted). Total staging is bounded across all holds (100 messages, 2.5 MiB, one full
  thread at a time; a thread that does not fit yet is read within a run only and is admitted when room frees up),
  and expires after 14 days. A longer thread (or a locator that cannot be trusted) is recovered by a
  whole-window **recovery walk**: it re-reads the mail window like an identity reread (removing nothing, resuming
  across runs under the unchanged read cap), lands the thread's pages as it goes, and clears the hold only when
  the walk completes without the thread failing again (a held thread the complete walk never saw is gone and is
  dropped). The walk's locator remembers the oldest message it knew; when the mail window (`a_mail_days`) no
  longer reaches that message the walk cannot prove the thread, so nothing partial lands, the hold and the
  incomplete coverage stay (and no futile walk is started) until the window covers it again: the window is never
  widened for you. `sync --full` does the same;
- retries are fair and bounded: units (one message, or one thread's list) rotate by a persisted turn (not by a
  failure count) within the per-run call budget, so a small readable unit is never starved behind a large one and
  what does not fit is first in line next run. A held record that is only being re-attempted is exempt from the circuit breaker, so many poison
  messages failing again (a quiet mailbox, or 4 or more at once) still advance their reconsideration and
  backoff; a run whose fresh traffic trips the breaker (a Mail outage) still counts no failure for anything;
- the circuit breaker judges messages and threads separately, so a Mail.app outage (most messages unreadable at
  once) counts no failure however many threads imported, and at most 100 items per source are held (a run that
  would exceed it fails before saving, so the cursor stays).

This is bounded by what the helper can observe: a single Mail scripting call that blocks cannot be interrupted
from inside the script, so a message whose read hangs is only ever stopped by the hard `helper_timeout`, which is
a source error and never counts toward a hold. The soft body budget limits how many reads start; it does not
guarantee a run finishes. A paginated walk freezes its starting window and
records its purpose, scope/owner digest and the union of seen thread ids in
`mail.walk`. Full reconciliation waits for the **entire** full walk, never just
its final suffix. A new full walk or changed identity discards an incompatible
resume cursor. Continue syncing to drain a capped walk; the cap is not raised.

Calendar notes: birthday calendars are skipped, and subscription calendars
(holidays, sports) are read only when selected with `--calendar-ids`. A recurring
event's pages are keyed on its series id plus the occurrence start, so
**rescheduling a series creates new occurrence pages**; the old ones stay until
`gbrain sync --source <id> --full` removes them. Multi-day timed events show the
end date as well as the time.

## Open loops (unanswered mail)

`gbrain waiting` / `open_loops` reuse the Google open-loop engine on Mail threads: "I owe a reply"
(inbound, unanswered after 24 h) and "I'm waiting on them" (your question, unanswered after 72 h), closed
automatically when the turn flips, with the same grace windows, mutes and noise rules.

```bash
gbrain apple setup --services calendar,contacts,mail --confirm-mail --mail-owner-addresses me@example.com,me-alias@example.com
gbrain apple loops --source apple-local --mail-owner-addresses me@example.com   # on an existing source (reads no Apple data)
```

- **Identity is explicit.** Direction comes only from `--mail-owner-addresses` (config `a_mail_owner_addresses`).
  The `--account` label is free text and the Sent mailbox is never read as identity (aliases, shared mailboxes).
  Without owner addresses Mail still imports, but loop tracking is **unavailable (`identity_missing`)**, and
  `gbrain waiting` says so instead of "You are clean". A source with Mail opted out is reported the same way
  (`mail_disabled`): `waiting` never answers "clean", and never "connect Google", for a Mac whose Mail it is
  not reading.
- **No model call for tracking.** Unanswered-mail detection is deterministic and needs no consent.
- **Extraction is a separate, second consent.** Commitment/decision extraction sends the text of Mail threads
  (sender, recipients, subject, plain-text body) to the chat provider configured for this brain, one call per
  eligible thread, within the daily `loops.extraction_max_usd_per_day` cap. It runs only when **both**
  `loops.extraction_enabled` (global, default on) **and** this source's `--consent-loops-extraction` (default
  off, needs owner addresses) are set; enqueue and every model attempt (including a truncation retry) re-read the current registered source, regardless of mutable page markers. The judge receives the configured owner addresses and aliases as trusted system context, separately from untrusted Mail text. Withdraw with
  `gbrain apple loops --revoke-loops-extraction`. Enabling it re-candidates eligible durable pages on the next sweep without requiring new mail.
  Global-off, provider, spend and queue-depth deferrals are retried from those pages on every sweep.
  Queue completion alone is not proof of extraction: skipped/failed revisions remain recoverable;
  only an extracted outcome settles a revision. The existing recent-thread extraction window and
  spend/depth caps still apply; no additional Apple read is needed for quiet catch-up.
- **Freshness.** `waiting` treats an Apple source as fresh only after a Mail sweep that was complete and
  detected loops in that same run. A Contacts or Calendar sync, a truncated or partly unreadable Mail run,
  a held or unimported thread, or a message the helper could not classify keeps the answer stale (`waiting`
  refuses unless `--stale-ok`). Changing the owner addresses makes the old freshness stale until a clean re-read.
- **No Gmail labels.** Mail has none, so none are invented. Machine mail (`Auto-Submitted`, `text/calendar`)
  and bulk mail (`List-Unsubscribe`, `List-Id`, `Precedence: bulk|list|junk`, no-reply `Reply-To`) are recognised
  from headers the helper reports; the Gmail category rule and `loops.extraction_exclude_labels` have no Apple
  equivalent. If that exclusion is configured, paid extraction for Apple sources is **withheld**
  (`excluded_label_unsupported`) rather than ignored; tracking is unaffected. `loops mute` works on Apple sources.
- **Durable evidence, bounded cache.** Each Mail page carries `apple_loop_messages`, aligned with
  **all** `apple_message_ids`, including direction, timestamp, classification and a 120-character
  quote-trimmed excerpt (questions beyond the excerpt retain a question mark). Incremental rendering
  carries this evidence forward alongside the full message blocks. Detection uses this complete
  merged evidence, not the cursor's diagnostic cache of 12 messages / 100 threads. Quiet grace
  obligations are re-evaluated from durable pages on every sweep, so eviction cannot erase them.
  `message_id` identifies the latest message using the same date-plus-id ordering as page blocks.
- **Recovery and upgrades.** Unavailable/failed threads remain in `mail_loops.pending_threads` until
  actually observed and evaluated successfully. A cache or page miss is never evidence of deletion.
  Unattributed unreadability sets `coverage_gap`; a nonempty clean whole-window walk must repair it.
  An empty later listing cannot clear those unknowns. Older pages without complete classified evidence
  are kept but refused for evaluation until a reader re-list supplies their missing evidence. If missing
  history is outside the configured read window, tracking remains incomplete rather than inventing a
  closure; the operator must restore evidence or explicitly adjust the read scope. No history cap is raised.
  Partial/refused/unclassified/denied runs invalidate `complete_at` and persist a reread obligation; a refused full reconcile retains its full walk, and a managed deferred save publishes invalidated loop bookkeeping without advancing its Mail cursor;
  `waiting` reports partial coverage and never "You are clean" for unresolved Apple coverage.
  Owner changes reconcile obsolete open deterministic rows (including self-mail) only after safe
  evaluation, without undoing manual done/drop/mute dispositions.

## Privacy and custody

- **Read-only.** The connector reads Calendar through EventKit, Contacts through
  the Contacts framework and Mail through Mail.app's scripting dictionary. It
  writes nothing to any of them.
- **No credentials.** There is no token, password or API key; macOS grants
  access per app. `--account` is only a label.
- **Local files.** Pages and the cursor state (`.apple-source.json`) live in the
  source's managed directory, created `0700` with files `0600`. Run
  `gbrain doctor` to check the permissions of anything else.
- **What leaves the machine.** Syncing itself sends nothing anywhere. After
  import the pages are ordinary connector pages, so the same optional steps as for
  Google pages apply: **embeddings** send page text to your configured embedding
  provider (use `--no-embed` / a local model to avoid it), and **atom
  extraction** sends the text of `email` and `meeting` pages (subjects, bodies,
  participants, up to `cycle.extract_atoms.max_input_chars`) to your configured
  chat model under the auto-drain dollar cap. To keep Mail and Calendar pages out
  of atom extraction: `gbrain config set cycle.extract_atoms.connector_pages false`.
  See [spend controls](../operations/spend-controls.md#atom-extraction-auto-drain-cap-and-connector-pages).
- **Loop extraction is opt-in per source** (`--consent-loops-extraction`): without it no Mail text is sent to a model for open-loop extraction (see [Open loops](#open-loops-unanswered-mail)).
- Apple connector pages are marked untrusted external content, like Google's.
- Items that fail repeatedly are held after 3 runs (`gbrain sources status <id>`,
  `gbrain sources retry-held <id>`, doctor `connector_held_items`). A permission
  denial is a source-level problem, never a held item.

## Troubleshooting

| Code | Meaning | Fix |
|---|---|---|
| `unsupported_platform` | not macOS | run on the Mac that has the data |
| `permission_denied` | Calendar/Contacts access denied | see [Permissions](#permissions) |
| `automation_denied` | Mail scripting denied | Automation pane, enable Mail for the app |
| `mail_not_running_or_unconfigured` | Mail.app has no account / is not ready | open Mail, add an account, retry |
| `helper_timeout` | a helper ran over its 120 s limit | retry (Mail bodies are budgeted and resume, so a repeat usually means a stuck permission dialog); narrow the window or mailboxes |
| `permission_not_determined` | macOS has not asked yet (not a denial) | run `gbrain apple setup` interactively and click Allow |
| `selection_not_found` | a configured calendar id or mailbox matches nothing (INBOX/Sent must resolve per eligible account) | fix `--calendar-ids` / `--mail-mailboxes` |
| `selection_ambiguous` | more than one mailbox fits the INBOX/Sent role in one account | name the exact mailbox in `--mail-mailboxes` |
| `mail_routing_unknown` | an enabled Mail account's provider cannot be safely determined | disable/fix that account, or opt Mail out; sync reads no Mail |
| `mail_routing_changed` | Mail account set/provider changed during a read | retry the sync; it starts over under the new routing |
| `awaiting_google_setup` | every enabled Mail account is Google-hosted | connect Mail with `gbrain google setup`; Apple Mail reads nothing |
| `macos_too_old` | the helper needs macOS 14+ / Command Line Tools 15+ | update macOS and the tools (`xcode-select --install`) |
| `helper_failed` | the helper crashed | install Xcode Command Line Tools 15+ (`xcode-select --install`) |
| `mail_confirmation_required` | `sources add` / `set-services` included Mail without `--confirm-mail` | confirm with the user, then add `--confirm-mail` |
| `extraction_consent_requires_identity` | `--consent-loops-extraction` without `--mail-owner-addresses` | pass the owner addresses with it |
| `malformed_output` | the helper printed something unparseable | retry once, then report the redacted output |
| `unknown_service` / `empty_services` | bad `--services` | pick from calendar, contacts, mail |
