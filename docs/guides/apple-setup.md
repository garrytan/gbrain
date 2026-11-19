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
- **Private and database-only.** Every page is `visibility: private` and lives only in the database, even on a brain
  that has a Git repository: nothing is written to the checkout, committed or pushed.
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
`--visibility` are refused: the source is always private and database-only.

Each sync reads the chats with new messages and rebuilds every day in the lookback window, so an edit or an unsend
on your phone shows up and facts taken from the old text are retired. A message deleted after the lookback stays
until you delete the page. Running a sync twice writes nothing the second time.

The owner-only rule also covers every page, fact and concept derived from the source's pages, wherever it is stored.
Removing the source (`gbrain sources remove`, with or without `--keep-storage`) or deleting one of its pages for good
leaves everything derived from it owner-only: a delete trigger records those rows first
([owner-only delete triggers](../ENGINES.md#owner-only-delete-triggers)). Nothing derived is deleted.

## Errors

### apple_helper_not_running

Nothing answered on the helper's port: the helper is stopped, the Mac is asleep, `apple.helper.port` is not set,
or the helper has its iMessage source turned off. Nothing was imported. Start GBrain Helper, check
`gbrain config get apple.helper.port`, then `gbrain sync --source <id>`.

### apple_helper_unauthorized

The helper refused gbrain's token, or gbrain has none. Save the helper's current token where GBrain reads it (above),
then sync again.

### apple_full_disk_access_pending

The helper is running but macOS has not let it read Messages. Open System Settings > Privacy & Security > Full Disk
Access, switch on GBrain Helper, then sync again. A grant turned off later gives the same error.

### apple_schema_mismatch

The helper does not recognise the Messages database, usually after a macOS update changed it. Update gbrain and
GBrain Helper, then sync again.
