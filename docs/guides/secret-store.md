# Secret store

When gbrain redacts a value that looks like a secret, it keeps the original in the **secret store** instead of
throwing it away. The page keeps a marker that names the store entry:

```
The deploy key is <REDACTED:openai:ss_4f9c2a7e1b03>.
```

`openai` is the scanner rule that matched and `ss_4f9c2a7e1b03` is the entry id. The original is encrypted in the
brain's database with a key that stays on the brain's machine. Nothing is rotated or revoked: if a real credential
reached the brain, its owner still rotates it.

What redacts into the store today: `gbrain repair secret-spans`, which replaces credentials in the database copies of
the pages you name (its retained page versions get the same markers, so the store is the only place the value stays),
and every publish of a brain checkout, which replaces them in commits that have not been pushed yet
([Publishing](#publishing)).

## Reading an original

| Who | How |
|---|---|
| The brain host (trusted local CLI) | `gbrain secrets reveal <id>` (`--json` adds where the marker occurs) |
| A remote agent over MCP | the `reveal_secret` tool, only with a token the owner allowed to |

`gbrain secrets list [--source <id>] [--slug <slug>]` lists entries and the pages holding their markers, never a value.

A remote caller needs both:

1. Its token's operation list names `reveal_secret`. The owner adds it to one token at a time from the brain host:
   `gbrain auth rescope --token <name> --refresh-operations` previews, then the same command with
   `--add reveal_secret`. A token with no operation list, `--all-new` and a harness token never get it.
2. It can read a page that holds the entry's marker (the same check `get_page` makes for that caller). A marker
   copied into another page binds to nothing.

Otherwise the call fails with `secret_reveal_forbidden`. Every reveal, CLI or MCP, is appended to the `secrets` audit
log (`~/.gbrain/audit/secrets-<year>-W<week>.jsonl`) with the entry, the caller and the pages, never the value.
That file and the `secret-spans` audit log are mode 0600, and a looser existing file is tightened on its next write.

## A false positive

```bash
gbrain secrets restore <id>                         # preview: the pages that get the original back
gbrain secrets restore <id> --apply --expect <hash>  # put it back
```

The restore replaces the marker with the exact original on every page where the redactor recorded it, rebuilds those
pages' search chunks, and marks the entry `allowed`, so later redactions leave that value alone.

## Keys

Each host keeps a keyring at `~/.gbrain/secret-store/keys/`: one `<key_id>.key` file per key (mode 0600) and
`current`, the key new entries use. The first redaction makes the key; there is nothing to set up.

- A key file is never overwritten. If the current key is missing, unreadable or readable by other users, gbrain adds a
  new key and carries on; entries sealed with the old key read again once its file is fixed or its escrow copy is
  imported.
- `GBRAIN_SECRET_STORE_KEY` (the base64 of 32 random bytes, for example `openssl rand -base64 32`) replaces the
  keyring. Use it for containers and for several hosts that share one database, so every host seals with the same key.
- `gbrain secrets key status` lists the keys this host can read and any key entries need that it lacks
  (`secret_store_key_missing` names it on a reveal).
- Keep a copy of the key away from the machine and its backups:
  `printf %s "$PASSPHRASE" | gbrain secrets key export --out key-escrow.json --passphrase-stdin`, and
  `gbrain secrets key import key-escrow.json --passphrase-stdin` on the host that needs it. A lost key loses every
  original it sealed.

The database holds only ciphertext, the key id, and an HMAC of the value under a key derived from the store key, so a
copy of the database or of a backup does not reveal originals without the key file.

## When an original cannot be kept

A redaction writes its marker only after the original is sealed in the store. When the store cannot be written (a
read-only database, a full disk), `gbrain repair secret-spans --apply` stops with `secret_store_unwritable` and changes
nothing, so no value is lost and none is left in the clear by this command. Fix what the error names, then run the
preview again.

## Publishing

When a push would carry a value that looks like a secret in a commit no remote has yet, gbrain no longer refuses the
push. It rebuilds those commits with the same markers, keeps each original in the store, and pushes the rebuilt
commits. This covers `gbrain git commit-push`, a managed worktree's page-write backups and every other automatic
publish. The details, and what is held back instead, are in
[shared-checkout-git.md](shared-checkout-git.md#publish_secret_redacted).

- Only the scanner's named rules redact. A value you restored with `gbrain secrets restore` is left alone.
- A reader of the remote sees `<REDACTED:<rule>:ss_<12 hex>>` in place of each value, in a file and in a commit message
  alike. Only the value is replaced: an AWS key id inside a presigned link becomes the marker and the rest of the URL
  stays, so the link stays readable (it no longer works, and an expired one did not anyway).
- A commit any remote-tracking ref already has is never rewritten; a value there still refuses the push.
- The old commits stay on this machine for 7 days under `refs/gbrain/backup/redact-<time>-<sha>`.
- To keep the old refusal instead: `gbrain config set secrets.on_push refuse`; `gbrain config set secrets.on_push redact`
  turns it back on.
- `GBRAIN_SECRETS_ON_PUSH=refuse` in the environment refuses too, whatever the config says. `refuse` is its only value:
  any other value, `redact` and an empty one included, changes nothing (it never turns redaction on where the config
  says `refuse`) and prints one `[gbrain notice]` line on stderr.
- When a managed worktree's page-write backup runs past its 300 s budget redacting or scanning, it is tried once more in
  the background with 4 times the budget. That checkout's backups wait for it; other checkouts carry on. Past that
  budget again, the backups are held with `publish_scan_unreadable`
  ([details](shared-checkout-git.md#publish_secret_rebuild_unbounded)).
- `gbrain git redact-unpushed --source <id>` shows what a publish would redact, writing nothing; `--apply --expect
  <hash>` does it without pushing.

<a id="secret_store_spooled"></a>A publish runs without the database, so it always first writes each original to an encrypted
spool on this machine, `~/.gbrain/secret-store/spool/` (directory 0700, one 0600 file per entry, the same key), and
says so with the info notice `secret_store_spooled`. The first publish that redacts creates the key. The
owner moves spooled entries into the store right after its push (a page write's Git effect), and maintenance (the
`bookkeeping_gc` phase) moves any that are left. `gbrain git commit-push` does not move them, so on a host where no
owner push and no maintenance run they stay in the spool; doctor's `secret_store` check counts them. `gbrain secrets reveal <id>` reads a spooled entry meanwhile, and `gbrain secrets list` (field `spooled` with
`--json`) shows how many wait. `gbrain secrets list` also counts entries and occurrences by rule (`by_rule`), and what
the publish redactions on this machine replaced by rule (`publish_redactions`): spans, values, and how many sat in a
presigned link's `X-Amz-Credential=` parameter as opposed to bare. An entry leaves the spool only once its store row reads back to the same original, so a
process that stops between its push and the move loses nothing: the next owner push or maintenance pass moves it. When
neither the store nor the spool can be written, the push is held with `secret_store_unwritable`.

## Health and backups

The store lives in the brain's database, so any database backup already carries it (ciphertext only; the key is never
in it). When the gbrain config names a `storage` backend for files (Supabase Storage, S3 or a local directory, the same
one `gbrain files` uses), gbrain also uploads an encrypted export of the store there:

- `gbrain secrets backup` uploads one now; the maintenance pass uploads one when the store changed since the last
  backup to that backend, or when the configured backend is one it never wrote to. Each object is
  `gbrain-secret-store/<time>.json`: every entry row (already sealed) and where it was redacted, read in one snapshot
  and sealed again under the current store key, so the bucket holds no value, page name, path or rule in clear, and
  never the key.
- A backup never creates a key. On a host with no store key, `gbrain secrets backup` refuses with
  `secret_store_key_missing`, maintenance skips the upload, and doctor says why; import the store key first.
- A failed upload never stops a push or a redaction. The next maintenance pass tries again, and doctor reports the
  last success and the last failure.
- `gbrain secrets backup --restore gbrain-secret-store/<time>.json` adds the entries this brain lacks. It restores only on
  a host whose keyring holds the key the backup names (import the escrow copy first), and it skips, and lists, any row
  that does not authenticate under it. An entry already here is left as it is, even when the backup's copy differs;
  the places the backup recorded for it that this brain lacks are added, so a later purge of one page never removes an
  original another page still holds. A restore only adds rows and never deletes one it did not write, and it ties a restored place to
  the page at its backed-up slug only when that page holds the entry's marker (`<REDACTED:<rule>:<id>>`), so a page
  that merely took an old slug, or quotes only the id, never gets the original. The marker counts when it sits in the page
  itself or in a timeline entry or fact filed on or about that page, so a copy another page wrote into that page's
  timeline counts too. A page whose body is stored in segments is read segment by segment. The restore ties the place
  to the exact page it checked and holds that page until it commits, so a rename running at the same time cannot hand
  the original to a page that takes the slug.
  An original recorded only on pages, none of which at its backed-up slugs holds its marker, is skipped and counted as
  `skipped_no_page` ("skipped because no page in this brain holds their marker"): the page was purged, is not synced
  yet, or was renamed before the backup named it by its current slug (a backup from before 0.60.744.0),
  and a restore cannot tell which, so it never brings back what a page purge removed. Sync the pages, then run the
  same restore again; it adds what it skipped. When every entry is skipped that way (a rebuilt brain before sync), the
  restore refuses with `invalid_params` and writes nothing, so a script never reads it as finished.
- With no storage backend nothing is uploaded and nothing is needed: `gbrain secrets backup` and doctor say the database
  backup carries the store.

Purging a page (`gbrain delete <slug> --purge`, or the expiry of a deleted page) removes the places the redactor
recorded on that page, and every sealed original no other page and no publish commit still references. An original
another page holds, or that a redacted publish commit points to, stays until those go too. A place recorded under a
slug the page had before a rename goes with the page too. A soft delete keeps everything, because the page can be
restored. Backups uploaded before the purge still hold the sealed original (encrypted, under the store key); delete
those objects from the bucket when it must be gone from there too, and a restore from one never brings it back while
the page is gone.

`gbrain doctor` runs the `secret_store` check, which never prints a value. It reports entries and occurrences, where the
store is backed up, and warns when:

- entries were sealed with a key this host does not have (`secret_store_key_forked`: usually another host sharing the
  database with its own key; set `GBRAIN_SECRET_STORE_KEY` to one shared key on every host, or import the escrow copy);
- the current key was never exported (`gbrain secrets key export` clears it), because a lost key loses every original;
- a storage backend is configured and the last backup failed or never ran;
- originals still wait in this host's encrypted spool;
- sealed originals are referenced by no page or commit any more (no remote caller can reveal them, and only the trusted
  local `gbrain secrets reveal <id>` reads them; a page purge removes its own, so these come from an older purge or a
  direct database edit);
- a checkout holds held-back publish commits, or local refs that still reach commits from before a redaction rebuild
  (the trusted local doctor only; a remote caller sees counts of entries, never paths or refs).

## What it does not do

- It does not rotate or revoke credentials.
- It does not erase bytes physically: dead database rows and WAL can hold old text until the database reclaims them.
- An original an older gbrain left an occurrence for after its page was purged stays: that occurrence still names it,
  so the cascade and doctor's count treat it as referenced.
- Markers written before the store existed (`<REDACTED:rule>` with no id) stay unrecoverable.
