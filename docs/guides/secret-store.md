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

<a id="secret_store_spooled"></a>A publish runs without the database, so it first writes each original to an encrypted
spool on this machine, `~/.gbrain/secret-store/spool/` (directory 0700, one 0600 file per entry, the same key). The
owner moves spooled entries into the store right after its push, and maintenance (the `bookkeeping_gc` phase) moves
any that are left. `gbrain secrets reveal <id>` reads a spooled entry meanwhile, and `gbrain secrets list` (field `spooled` with
`--json`) shows how many wait. `gbrain secrets list` also counts entries and occurrences by rule (`by_rule`), and what
the publish redactions on this machine replaced by rule (`publish_redactions`): spans, values, and how many sat in a
presigned link's `X-Amz-Credential=` parameter as opposed to bare. An entry leaves the spool only once its store row reads back to the same original, so a
process that stops between its push and the move loses nothing: the next owner push or maintenance pass moves it. When
neither the store nor the spool can be written, the push is held with `secret_store_unwritable`.

## What it does not do

- It does not rotate or revoke credentials.
- It does not erase bytes physically: dead database rows and WAL can hold old text until the database reclaims them.
- Markers written before the store existed (`<REDACTED:rule>` with no id) stay unrecoverable.
