# Page history: why a page changed

**Say to your agent:** *"Update the refund policy to a 30-day window, and record that the client asked for it."*

Every page write in gbrain keeps the text it replaced as a version. A write can
also carry a short human reason, so the history says why the text changed, not
only that it did. This guide covers how to give a reason, where it is stored,
who can read it, and what happens on a brain with no Git repository.

## Reasons

Pass `reason` on `put_page`, `edit_page`, `revert_version` or on any item of
`put_pages`:

```json
{ "slug": "policies/refunds", "expected_revision": "…", "content": "…",
  "reason": "Client asked for the 30-day window." }
```

The parameter is listed on the full MCP tool surface. The starter surface leaves
it out of the tool schemas to keep them small, but still accepts it, so an agent
on the starter surface can pass it too. On the CLI the same parameter is `--reason`, for example
`gbrain put policies/refunds --reason "Client asked for the 30-day window." < refunds.md`.

A reason is one line of at most 500 characters. Tabs and line breaks become
spaces, other control characters are removed, and an empty reason counts as
none. It is checked before the write is accepted, so a refused reason leaves no
copy anywhere, except opt-in `serve --log-full-params` logging:

- longer than 500 characters: `change_reason_rejected` with reason
  `reason_too_long` (the wire `error` is `invalid_params`), naming the length
  and the limit;
- it looks like it holds a credential: `change_reason_rejected` with reason
  `reason_contains_secret`, naming the detector and the character position,
  never the value.

Shorten the reason or remove the secret, then send the write again. The reason
is part of the request's identity: replaying a `request_id` with the same
reason replays the write, and replaying it with a different reason is a
conflict. In `put_pages`, one refused reason refuses the whole batch and names
the item; two copies of a page with the same reason are written once, and two
copies with different reasons are refused.

### Where the reason is stored

A version is the page as it was before a write. So the reason is stored on the
version that write archived, and `get_versions` shows it on that version as
`replaced_because`. The newest version's `replaced_because` explains the text
you read now. `gbrain history <slug>` prints it as `changed because: …` under
each version.

A page's first write archives nothing, so its reason has no version to sit on.
Every write result says where its reason went in `reason_recorded`:

| Field | Meaning |
|---|---|
| `reason` | The reason as stored, after the cleanup above. |
| `version` | `true` when a version carries it. |
| `version_why` | Why no version carries it: `page_created` (first write) or `no_change` (the write changed nothing). |
| `git` | Where Git stands, below. |

`git` is one of:

- `committed`: on a git-canonical source the commit landed with the write.
- `queued`: the file's commit is queued and will carry the reason.
- `superseded`: a newer write to the same file committed first (shown on the
  receipt, `get_write_request`, with a `reason_not_committed` notice). The
  reason stays in gbrain's history but is in no commit. Nothing needs fixing,
  and retrying the write would be wrong.
- `private`: the page is private, so its reason stays out of every commit
  message, group commits for other pages included. Visibility is checked when
  the commit is made: a page that a later page in the same `put_pages` group
  made private (through `derived_from`, for example) commits without its
  reason, and so does a queued commit whose page a later write made private.
- `not_file_backed`: the page has no file (database-only), so the reason is in
  gbrain's history only.
- `no_repository`: the brain has no Git repository (below).
- `none`: the write changed nothing.

### In Git

When the page's file reaches Git, its commit carries the reason as a trailer
naming the file:

```
gbrain-reason: policies/refunds.md: Client asked for the 30-day window.
```

There is one trailer per file, in the same trailer block as any
`gbrain-repair:` trailer, so `git interpret-trailers --parse` lists them all.
A write without a reason commits exactly the message it did before. A commit
you make yourself can give a reason the same way:

```bash
git commit --trailer "gbrain-reason: policies/refunds.md: Client asked for the 30-day window."
```

A sync reads these trailers back into page history ([reasons from
Git](#reasons-from-git)). A pushed commit message cannot be changed, so treat a
reason like any other text you push. There is no operation to add a reason to a past write.

### Repo-less brains

A brain without a Git repository, such as the default keyless install, gets the
same feature. The database is the record there: the reason is stored on the
version by the same write, `get_versions` shows it the same way, and
`reason_recorded.git` is `no_repository`. Nothing is refused because there is no
repository. If you connect a repository later, the reasons already stored stay
where they are; old versions are not rewritten into commits.

### Who can read a reason

A trusted local caller sees every stored reason. A remote caller (an MCP client)
sees a version's reason only when both that version and the version that
replaced it are world-visible. The reason for turning a page private, or for
any change made while it was private, is therefore never shown remotely. When
the replacing version was later pruned (large pages keep a few versions), its
visibility can no longer be checked and the reason is withheld from remote
callers. Remote reasons go through the same text sanitizer as version bodies.

## Reasons from Git

When `gbrain sync` imports a changed file from a Git checkout, it reads the
`gbrain-reason` trailers of the commits it is importing and stores the
file's reason on the version that import archives. A commit you make yourself
with `git commit --trailer "gbrain-reason: <path>: <text>"` therefore shows up
in `get_versions` as `replaced_because`, the same as a reason given to
`put_page`.

How a sync picks the reason for a file:

- It reads the commits between the last synced commit and the new one along the
  first-parent line, which is the history the checked-out branch came from. A
  merge counts as changing every file it changed relative to its first parent.
- The newest of those commits that changed the file decides. Its trailer for
  that file is the reason. If it has none, the version gets no reason, so an
  older reason is never shown against newer text.
- A merge that resolved a conflict decides with its own trailer, so put the
  trailer in the merge message. A commit on a merged side branch never decides,
  whether its edit was kept or discarded.
- The trailer names the file by its path in the repository (or under the
  source's folder when the source is a subfolder), then `: ` and the text. A
  trailer that names no file its commit changed is skipped and counted in the
  sync result's `reason_trailers_malformed`.
- A reason from Git gets the same cleanup and limits as a written reason. One
  longer than 500 characters is skipped and counted the same way.
- A file's first import creates its page and archives nothing, so it stores no
  reason, as with a page's first write.

When one sync imports more than one commit for a file, the versions in between
were never stored. The sync marks the page as having a gap in its history, so
readers of old versions know some are missing.

A trailer already in Git that looks like a credential is not stored. The sync
prints the `reason_trailer_secret` notice, which names the commit and the file,
never the value. Rotate that credential: Git history keeps the commit message.

If reading the trailers fails (a Git error, or more than two minutes), the sync
prints `reason_scan_failed`. If the range holds more than 10,000 commits, it
prints `reason_scan_capped` instead of reading them. Either way the content is
imported, because reasons never hold up content. Every version that sync
archives stores no reason, and each page it changed is marked with a history
gap. This release does not backfill reasons for that range: the sync still
moves its last synced commit forward, and a later sync does not read the range
again. The reasons are still in Git, and the notice's command lists them:

```bash
git log --first-parent --format='%H %(trailers:key=gbrain-reason,valueonly)' <range>
```

A commit and file that a purge has tombstoned (below) never gives a reason
again, not even on a full re-import.

A source with no Git checkout (a repo-less brain, or a folder imported with
`gbrain import`) reads no trailers, prints none of these notices and marks no
gap. Its reasons come only from the writes that carry them.

## Purge and reasons

`gbrain forget <id> --purge` ([expire versus purge](memory-boundaries.md#purge))
reaches every copy of a reason that quotes the claim:

- **Versions.** The reason is replaced with `[purged]` on every version that
  carries it, inline and segmented alike, and counted in
  `removed.page_versions`.
- **Queued and kept Git commits.** The source's Git effects whose commit message
  would quote the claim, whether queued, failed or kept after they ran, are
  redacted in the same transaction: the line becomes `[purged]` and the trailer
  that quotes it is dropped (`removed.persistence_effects`). If one is being
  written right now, the purge stops with `purge_blocked_pending_recovery`;
  retry once it finishes.
- **Commits already in the repository.** Purge never rewrites Git history, so a
  pushed commit keeps its message text, as it keeps the file's earlier
  contents. Before it deletes anything, purge reads the `gbrain-reason` trailers
  on the source's first-parent history up to `HEAD` (up to 200,000 commits) and
  records each commit and file whose reason quotes the claim. The record holds
  no text. No later sync, cold re-import or re-derive stores that reason again.
  The receipt counts these in `removed.reason_purge_tombstones` and lists the
  commits under the `git_commit_messages` residual.

Purge refuses before it changes anything when it cannot read that history:

- `reason_purge_scan_failed`: reading the trailers failed: the source's folder
  is missing or moved, `git` is not installed, Git refuses the repository (an
  unsafe owner or a corrupt `.git/config`), or the read timed out. Nothing was
  changed; fix the cause or wait, then run the same purge again.
- `reason_purge_scan_capped`: the history is longer than 200,000 commits. Your
  agent asks you to choose: purge now and check only the newest commits, with
  `--reason-scan-limit <n>` set to the number you pick, or stop. With a limit, a
  reason in an older commit is not tombstoned and a re-import could store it
  again; the receipt says so.

A source counts as having no Git checkout only when it has no folder, or when
Git itself says its folder is in no repository. Then there is no history to
read, so purge redacts the database copies and never raises either refusal.

`gbrain delete <slug> --purge` also reaches the purged page's own reasons. Before
anything is deleted it reads every reason the page's versions and write
receipts recorded, then removes them from the page's receipts and stored
intents, and drops the commit line and trailers from every Git effect of the
page, queued, failed or kept, with the same `purge_blocked_pending_recovery`
refusal while one carrying a reason is being written. Its receipt checks both
stores (`persistence_requests`, `persistence_effects`). Commits already in the
repository keep their messages, as above.

## Choosing how to record a change

A reason explains an edit to one document. Pick the shape that matches what
happened:

| What happened | Do this |
|---|---|
| The same document changed (a new edition, a correction) | Edit the page in place with `expected_revision` and a `reason`. |
| A separate document amends part of it | Write the amendment as its own page with an `amends` link (`since` the date it applies). |
| A different document replaces it entirely | Keep both pages and add a `supersedes` link from the new one. |

Do not create a second page for a new edition of the same document: the
history of one page, with reasons, is what readers and agents follow.

## Valid time

A page can say when its text takes effect. Put `valid_from` (and, if the text
stops applying, `valid_until`) in its frontmatter:

```yaml
---
title: Refund policy
valid_from: '2026-07-01'
valid_until: '2027-01-01'
---
```

The dates are part of the page, so on a brain with a Git repository they live
in the file and in every commit, and gbrain keeps them on each retained version.
The interval is half-open: the text is in force from `valid_from` up to, but
not including, `valid_until`, the same rule links use. Write the dates quoted.
An unquoted YAML date also works; a partial date (`2026-07`), a time of day or
another zone does not, and the write result warns `valid_from_unparsed`.

**Say to your agent:** *"What did our refund policy say on March 1?"* The agent
reads the page with `get_page {slug, as_of: '2026-03-01'}` (CLI:
`gbrain get <slug> --as-of 2026-03-01`).

Nothing changes until a page carries `valid_from` or a caller passes `as_of`.
There is no config key.

### Which tool records a change in effect

| The change | Record it as | as_of reads |
|---|---|---|
| The text of the page changes from a date on (a new edition) | edit the page in place and set `valid_from` to that date (keep the old date for a plain correction) | the edition whose `valid_from` is the latest on or before the date |
| A separate document changes part of it (an addendum, a rider) | an amendment record: its own page with an `amends` link to this page, dated by its `since` | the page's own edition; amendments dated after that edition and on or before the date are listed in `valid_time.amendments_not_applied`, not merged into the text |
| A new page replaces this one | a `supersedes` link from the new page | this page's editions only; follow the link for the new page |

### How the edition is chosen

The candidates are the current page and its retained versions. The answer is
the edition with the greatest `valid_from` on or before the date; when two
share that date, the one recorded last wins, as a correction of that edition.
Nothing is excluded by guesswork.

Some histories look alike: a corrected date, a renewal of unchanged text, a
backfilled old edition and a withdrawn scheduled edition all leave the same
shape. When the versions around the date have that shape (the same body under
another `valid_from`, or a version recorded later with an earlier
`valid_from`), the answer is still the rule's pick, and it says so:
`valid_time.uncertain: true`, `why: ambiguous_edition_dates`, with
`competing_version_ids`. Its `fix` asks the user which date the edition took
effect, then offers an `edit_page` that sets `valid_from`.

If the chosen edition is private (or below the caller's `min_trust`), a remote
caller gets the answer a private page gets: not found. It never falls back to an
older edition it may see. Reasons follow the same rule as `get_versions`.

### The answer

`valid_time` is in every answer:

| Field | Meaning |
|---|---|
| `as_of` | the date asked about, echoed |
| `status` | `in_force`, `not_in_force` (its `valid_until` has passed), `not_yet_in_force` (every edition starts later, and gbrain holds the page's whole history), `before_recorded_history` (every known edition starts later, but earlier editions may exist outside gbrain) |
| `chosen_version_id`, `chosen_is_current` | which edition was picked (`null` id for the current page) |
| `valid_from`, `valid_until` | the chosen edition's dates |
| `introduced_because`, `replaced_because` | the reasons given for the write that produced the edition and the one that replaced it |
| `history` | `retained`, `incomplete` or `unknown` |
| `uncertain`, `why` | whether to trust the pick, and the one reason not to |
| `undated_versions` | versions with no readable `valid_from`; they are never picked |
| `amendments_not_applied` | amendment records in force on the date that the text does not include |
| `recorded_since` | when gbrain recorded the chosen edition |

Only `in_force` returns the text at the top level. Any other status puts the
edition under `last_in_force` or `earliest_known`, so a reader that ignores
the status cannot quote expired or future text as current.

A large edition is returned in windows. Each `next` call carries the slug,
source, date and a cursor pinned to that edition, so the read stays on it even
if the page changes meanwhile.

On the CLI, `gbrain get --as-of` prints a `[gbrain] valid_time` line on
stderr. An `in_force` answer prints the page on stdout and exits 0. Any other
status prints `status:` and `why:` on stdout, no page, and exits 15
([exit codes](exit-codes.md)).

A plain read (`get_page`, `gbrain get`) of a page whose own `valid_from` is
after today, or whose `valid_until` has passed, also carries `valid_time`
(`status`, `as_of` today and both dates), and the CLI prints it on stderr.

### When history is incomplete

gbrain can only answer from the versions it kept. The answer says when that is
not enough, and only when it matters for the date asked about:

- `history_pruned` or `history_gap`: versions were pruned, or a sync imported
  several commits of the file at once, inside the chosen edition's span (or the
  date is before every retained edition). Dates the retained editions cover
  after the gap stay certain.
- `history_unknown`: the page has enough large or segmented versions that a
  prune may have run before gbrain recorded prunes.
- `before_recorded_history`: the page came from a file, so editions before
  its first gbrain version may exist in Git.
- `edition_pruned`: the edition a window cursor pinned is no longer retained;
  no text is returned.

The `fix` depends on where the missing history lives. For a page whose file
sits in a Git checkout, it is `git log --follow -p -- <path>` (a remote caller
gets it as a command to relay). For a private, database-only or unfiled page,
and on a brain with no Git repository, it asks the user for a retained copy or
a backup; retrying the read unchanged gives the same answer.

### Brains with no Git repository

The default keyless install has no Git repository, and valid time works the
same there: the dates are in the stored frontmatter of each version, the pick
and every status come from the database, and the recovery asks for a backup
instead of naming a Git command.

### Writes that keep or change the date

A write result can carry a `valid_time` advisory:

- `valid_time_correction`: the body changed and `valid_from` did not, so
  the change is read as a correction of the edition in force since that date.
  Set `valid_from` if the change takes effect later.
- `valid_time_date_only`: only `valid_from` changed. That is a question, not
  an error: is this a correction of the earlier date, or a renewal of unchanged
  text? as_of reads around those dates are marked `ambiguous_edition_dates`.
- `valid_from_unparsed`: `valid_from` is not a date gbrain can read.

### valid_time_undeclared

No retained version of the page has a readable `valid_from`. gbrain does not
invent one. The `fix` asks the user when the text took effect, then offers an
`edit_page` that adds a quoted `valid_from`. To ask what the brain had
recorded at a moment instead, read with `known_as_of` (recorded time).

### Refusals

`as_of` takes a calendar date. An instant is refused `clock_mismatch` with
reason `instant_for_date` ([clock mismatch](repair.md#clock-mismatch)). It does
not combine with `known_as_of`, or with `include_content` or
`content_only`: writing an old edition back would silently revert the page.
A slug that exists in two sources you can read is refused until you pass
`source_id`.

### host_upgrade_required

The gbrain CLI or an MCP client asked a host for `as_of`, and the reply did
not echo `valid_time.as_of`. An older host ignores the parameter and returns
the current page, so the client prints nothing and exits 16. The error names
the client version, the host version and the minimum host version. Run
`gbrain upgrade` on the brain host, or ask whoever runs it. Without
`valid_time` in a reply, the reply is the current page.
