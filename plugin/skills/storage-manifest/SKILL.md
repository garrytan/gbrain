---
name: storage-manifest
version: 1.0.0
description: |
  The storage shelf: one card per item archived to object storage (B2,
  Supabase Storage, S3). Register a card after a verified archive, find a
  card before any restore, restore through the agent's own restore skill with
  the card's restore form, then record the restore on the card.
triggers:
  - "bring back"
  - "restore the archived"
  - "where did X go"
  - "what's in B2"
  - "what did we archive"
  - "register this archive"
tools:
  - storage_find
  - storage_get
  - storage_list
mutating: true
writes_pages: false
when_to_use: "Use when the user asks: \"bring back\", \"restore the archived\", \"where did X go\", \"what's in B2\", \"what did we archive\"."
---

# Storage manifest

> **Convention:** see [conventions/brain-first.md](../conventions/brain-first.md):
> look on the shelf with `gbrain storage-find` before listing a bucket or asking the user where something went.

Full guide: `docs/guides/storage-manifest.md`.

## Contract

- **Register after the archive is verified, never before.** Once the upload's checksum or snapshot check passed,
  run `gbrain storage-register --card '<json>'` (or pipe the card on stdin) from the trusted local CLI. The card
  names every copy (store, bucket, path, tool, repository, snapshot, size, hash and its kind, when verified), the
  original path, why it was archived, and the restore form `{ skill, args }`.
- **Find before restore.** `gbrain storage-find "<the user's words>" --json` (MCP `storage_find`), then
  `gbrain storage-get <id> --json` for the copies and the restore form. A miss lists the closest cards: show them.
  On `storage_record_invalid` the stored card is broken: tell the user and do not restore from it.
- **Restore through the agent's own restore skill.** Run the skill the card's `restore.skill` names with
  `restore.args`. Cards never carry commands or credentials; the restore skill reads credentials from its own
  environment. gbrain never contacts a store.
- **Record the restore.** After the restore, run `gbrain storage-update <id> --expected-revision <rev>
  --restored-to <path>` with `--restored-verified` only when the checksums matched. `<rev>` is the revision
  `storage-get` returned; on `storage_revision_conflict` read the card again and update once.
- **Interim records** (`stored-object` pages under `storage-manifest/` written before the shelf existed) move with
  `gbrain storage adopt`: preview, show the user every refused field, then apply the printed command.

## Anti-Patterns

- Putting a command, a password, a signed URL or an environment assignment on a card: it is refused.
- Writing the shelf with `put_page` or `remember`: refused `storage_source_managed`.
- Restoring from a bucket listing without reading the card first.
- Recording `--restored-verified` without checking the hashes.

## Output Format

Tell the user what the card says in plain words: what the item is, where each copy lives, its size, when it was last
verified, and which skill restores it. After a restore, say where it landed and whether the checksums matched.

## When it fails

Read the refusal's `code` and follow its `fix` (see [the agent operator protocol](../conventions/agent-operator-protocol.md)).
`storage_manifest_missing` on a brain with a Git checkout means the shelf is not hosted yet: relay the
`gbrain storage init` preview to the user.
