# iMessage on a Mac

The `imessage` source kind brings your Messages history into your brain: one page per chat per day. It reads
through GBrain Helper, a small app that runs on your own Mac and is the only thing that opens the Messages
database. gbrain talks to the helper over `127.0.0.1` and never reads the database itself.

Your messages hold other people's words, so these pages get stricter handling than any other kind:

- **Owner-only.** Only you read them: the gbrain CLI on the brain's machine, and agents whose credentials are bound
  to you as the brain's owner (`gbrain access owner set <member>`). Every other member, guest, shared room, attested
  call or unbound key gets `not_found`, for the pages and for anything derived from them (facts, concepts,
  timelines), whatever relaxations the brain has on. See
  [owner-only sources](access-designations.md#owner-only-sources-owner_only).
- **Private.** Every page is `visibility: private`. On a personal brain with a Git checkout the pages are also files
  in that checkout, so they are kept and pushed like your other pages ([where the pages live](#where-the-pages-live));
  anywhere else they live only in the database.
- **Untrusted text.** Pages are stored at the external-untrusted trust tier, like email, so instructions inside a
  message are never treated as yours.
- **Nothing paid by default.** Pages are embedded and facts extracted only if you configured a provider for that.

## Register and sync

```bash
gbrain config set apple.helper.port <port>     # the helper's loopback port
gbrain sources add messages --kind imessage --timezone America/Los_Angeles
gbrain sync --source messages
```

The helper's token is read from `GBRAIN_CONNECTOR_IMESSAGE_TOKEN`, else from `~/.gbrain/connectors/imessage.json`
(mode 0600), or from the variable a source names with `--token-env`. It never goes in `sources.config`, the
database or a log.

Options: `--history-days` (how far back the first sync reads, default 30), `--lookback-days` (recent days re-read
every sync, default 7), `--timezone` (where a day page starts at midnight, default UTC), `--sync-interval-min`
(default 15) and `--federated` (join unqualified searches; off by default). `--dir`, `--record` and
`--visibility` are refused: the source is always private, and gbrain decides where its pages live (below).

Each sync reads the chats with new messages and rebuilds every day in the lookback window, so an edit or an unsend
on your phone shows up and facts taken from the old text are retired. A message deleted after the lookback stays
until you delete the page. Running a sync twice writes nothing the second time.

The owner-only rule also covers every page, fact and concept derived from the source's pages, wherever it is stored.
Removing the source (`gbrain sources remove`, with or without `--keep-storage`) or deleting one of its pages for good
leaves everything derived from it owner-only: a delete trigger records those rows first
([owner-only delete triggers](../ENGINES.md#owner-only-delete-triggers)). Nothing derived is deleted.

## Where the pages live

On a personal brain (one owner, not shared) whose default source is a Git checkout, each chat day is also a file at
`.gbrain-owned/<source-id>/imessage/<chat>/<day>.md` in that checkout. There is nothing to set up.

- **One commit per sync.** A sync that changed something makes one commit, for example
  `imessage(messages): 3 chat-days updated, 1 removed`; a quiet sync commits nothing. The commit lands before the
  database rows, so Git stays the record.
- **Who reads them.** gbrain still shows them only to you. Anyone who can read the repository can read the files, so
  gbrain writes them only when it can prove the checkout pushes to a private repository (or to a path on this
  machine), and the first commit's README names where it pushes. A public repository, or one gbrain cannot check
  (offline, an unknown host), keeps the pages in the database only (`not_private`). If the destination changes
  later, the pages stay in the database only until you confirm it: `gbrain sources rebind <id>` previews, then
  `--yes` records the new one; it refuses a destination that is not proven private.
- **Nothing else touches the folder.** The default source's sync, import, repairs, `frontmatter --fix`,
  `file_upload` and `gbrain git commit-push` all leave `.gbrain-owned/` alone. A file there that gbrain did not
  write, or one you edited, is never overwritten or deleted: that day stays in the database only. To change a
  conversation, change it in Messages; `put_page`, `edit_page` and `delete_page` on these pages are refused.
- **Removals are careful.** A day file is removed only when the helper reports that day empty. A sync that would
  remove more than 20 day files, or more than a tenth of them once more than two would go, removes none and says
  so.
- **Without the Mac.** If the helper is not reachable, `gbrain sync --source <id> --full` rebuilds the database
  pages from the folder.
- **Status.** `gbrain sources status <id>` shows `pages_in`: the folder or the database (and why), the last
  commit, whether it is pushed, and how many days are held.

Pages imported before this change stay in the database until their day changes or you run
`gbrain sync --source <id> --full`, which re-reads only the history window.

On a brain without a repository, a shared or managed brain, or a checkout whose Git ignores or filters
`.gbrain-owned/`, the pages stay in the database only, and each sync prints
`[gbrain notice owned_folder_database_only]` with the reason. When Git refuses the commit (a rebase in progress,
a hook, a busy commit lock, no Git identity), that run's pages go to the database and the next run writes the days
it changed to the folder.

### What a push carries

A push carries the day files like any other page. Push-time redaction (the default `secrets.on_push redact`) catches
known key and token shapes only, such as API keys and access tokens. A one-time code or password written in a message
is not redacted and is pushed as written, which is why the folder is written only when the checkout pushes to a
repository proven private. With `secrets.on_push refuse`, a day whose text matches one of those key or token shapes
is not committed (`owned_day_secret_held`); it stays searchable in the database and the file committed earlier stays.

### How to stop it

`gbrain sources remove <id>` removes the folder's files in one commit (it keeps any file it cannot prove it wrote)
and removes the pages. The remote's history still holds what was pushed. `--keep-storage` leaves the files. While a
sync of that source is running, the removal refuses (`lock_busy`) and removes nothing; run it again when the sync ends.

### owned_folder_conflict

A file under `.gbrain-owned/` is not what its source wrote (edited or added by hand, a symlink, another source's
folder), or another command tried to use the folder. Nothing there was changed. Move the file out (or restore it
with `git checkout -- <path>`), then `gbrain sync --source <id>`.

## Contacts

The same helper serves your Mac's address book to the `apple-contacts` source kind: one private contact page per
contact, an exact email or phone link to the matching person page, and `## Facts` rows on that page for the
company, job title and Contacts groups. Phones and emails stay on the owner-only contact pages. See [Apple Contacts](apple-contacts.md).

## Errors

### apple_helper_not_running

Nothing answered on the helper's port: the helper is stopped, the Mac is asleep, `apple.helper.port` is not set,
or the helper has its iMessage source turned off. Nothing was imported. Start GBrain Helper, check
`gbrain config get apple.helper.port`, then `gbrain sync --source <id>`. When the pages are in the checkout's
folder, `gbrain sync --source <id> --full` rebuilds the database pages from it without the helper.

### apple_helper_unauthorized

The helper refused gbrain's token, or gbrain has none. Save the helper's current token where GBrain reads it (above),
then sync again.

### apple_full_disk_access_pending

The helper is running but macOS has not let it read Messages. Open System Settings > Privacy & Security > Full Disk
Access, switch on GBrain Helper, then sync again. A grant turned off later gives the same error.

### apple_schema_mismatch

The helper does not recognise the Messages database, usually after a macOS update changed it. Update gbrain and
GBrain Helper, then sync again.
