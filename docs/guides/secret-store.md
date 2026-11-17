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
the pages you name (its retained page versions get the same markers, so the store is the only place the value stays).

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

## What it does not do

- It does not rotate or revoke credentials.
- It does not erase bytes physically: dead database rows and WAL can hold old text until the database reclaims them.
- Markers written before the store existed (`<REDACTED:rule>` with no id) stay unrecoverable.
