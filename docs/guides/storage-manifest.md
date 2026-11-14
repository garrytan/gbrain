# Storage manifest

The storage manifest is a shelf of cards, one per item an agent archived to object storage (B2, Supabase Storage,
S3, R2, GCS). A card says what the item is, where every copy lives (store, bucket, path, restic repository and
snapshot, size, file count, hash and its kind, when it was verified), where it came from, why it was archived, and
which skill restores it. Months later an agent finds the card from a plain phrase and restores the item through its
own restore skill.

**Say to your agent:** *"Bring back the October mail dataset."*

**Say to your agent:** *"Where did the old research runs go?"*

**Say to your agent:** *"What's in B2?"*

The skill behind these is `skills/storage-manifest/SKILL.md`.

## The verbs

| Step | CLI | MCP tool |
|---|---|---|
| Find a card from a phrase (closest cards on a miss) | `gbrain storage-find "<phrase>"` | `storage_find` |
| Read one card, its restore form and revision | `gbrain storage-get <id>` | `storage_get` |
| List cards by store, status or source machine | `gbrain storage-list [--store b2] [--status archived]` | `storage_list` |
| Register a card after a verified archive | `gbrain storage-register --card '<json>'` (or stdin) | local CLI only |
| Change a card, or record a restore | `gbrain storage-update <id> --expected-revision <rev> [--patch '<json>'] [--restored-to <path> --restored-verified]` | local CLI only |

A restore runs through the agent's own restore skill: the card's `restore.skill` with `restore.args`. Cards never
carry commands or credentials, and gbrain never contacts a store. After the restore, `storage-update` with
`--restored-to` records where it landed (newest first); pass `--restored-verified` only when the checksums matched.
An update keeps the card page's access labels (`visibility`, `readable_by`), so a restricted card stays restricted.

## Repo-less brains and brains with a Git checkout

On a repo-less brain, including a fresh keyless install whose content directory (created by `gbrain init`) holds no
Git checkout, the database is the record: the first `storage-register` (or `gbrain storage init`) creates the
`storage` source, database-only and not federated, and every verb works there. If that first creation stopped part
way (a crash, two first registers at once), the next register or `gbrain storage init` finishes it, so an empty
`storage` source with no directory of its own counts as the shelf. A `storage` source that holds pages, or (on a
repo-less brain) has its own directory, is never taken over: the verbs refuse `storage_manifest_missing`, as they do while the shelf is archived (until
`gbrain sources restore storage`).

On a brain with a Git checkout, Git stays the parent. `gbrain storage init --dir <absolute path> --dry-run` previews a
hosted Git repository for the shelf, and the printed `--expect <plan_hash>` command creates it after the user agrees
(it needs managed persistence). Every card is then a commit before the database indexes it. Until init has run,
register, adopt and import refuse `storage_manifest_missing` with that preview as the fix.

## Adopt interim records

Agents that archived before the shelf existed often kept interim pages: `type: stored-object` pages under
`storage-manifest/`, each with its record as JSON in a fenced `json` block under a `## Record` heading.
`gbrain storage adopt` moves them onto the shelf in three preview-first steps:

1. `gbrain storage adopt [--source <id>] [--from-prefix <prefix>]` previews: per page, the card it maps to and each
   field a card refuses with its reason (`command_field` such as `restore.command`, `unknown_field`,
   `stamped_field`). It writes nothing and prints a `plan_hash`. The index page (`<prefix>index`) is skipped.
2. The printed apply, `--apply --expect <plan_hash>` with one `--drop-field <dotted.name>` per refused field, runs
   after the user agrees to leave those fields out. It registers each card with `origin: adopt` through the same
   path `storage-register` uses, then tags the original `storage-manifest-adopted`. It deletes nothing. A
   credential-shaped value (a secret, an environment assignment, a credential variable, a URL password, a signed URL,
   a value under a credential-named key such as `restore.args.password`, `restic_password` or `token_count`, unless the
   key ends in `_id`, `_ref`, `_name`, `_path`, `_file`, `_env`, `_var` or `_variable`) always refuses, whatever is
   dropped: fix the source page first, renaming a key that holds no credential to end in one of those suffixes. A
   record whose page a remote (MCP) client last wrote is blocked (`remote_written`) and never becomes a card: check it
   and register the item yourself with `storage-register`. Each card takes its original's access labels (`visibility`,
   `access`, `confidentiality`, `readable_by`), with `readable_by` narrowed to the readers that every folder rule over
   the original also lists (readers match literally, so a member is not matched to its groups), so no card is read
   wider than its original. An original whose readers and folder rules share no reader (`access_unpreservable`), or
   whose rules are still being applied (`access_pending`), is blocked until you restrict the card some other way.
3. `gbrain storage adopt --finalize` previews soft-deleting the tagged originals; its `--expect <plan_hash>` run deletes
   them (restorable for 72 hours with `gbrain restore`), only when every adopted card is on the shelf and matches its
   original's mapped card and carries the access labels the original needs. A restore recorded with `storage-update` since adoption is not a difference. The preview
   names any `##` section in an original's body other than `## Record` (notes the card does not carry, which go with
   the page; a timeline section gbrain stores apart from the body is not listed) and flags an original longer than the 64 KiB it reads, so you read the rest first. The plan_hash binds each
   original's whole content, checked again just before each delete, so an original edited after the preview refuses
   `preview_changed`.

A rerun skips cards already on the shelf that match and originals already tagged. A card on the shelf that differs is
a conflict (a card without the original's access labels too): it is reported and never overwritten, and its original
stays untagged. Every apply reports `side_effects: none | partial | complete`; a run that stopped part way prints the
command that finishes it. A write gbrain accepted that has not committed yet is listed under `pending` with its
receipt: poll it with `gbrain write-request <id>` (the command exits 10) and rerun once it has committed, never submit
it again.

## Export and import (JSONL)

`gbrain storage export --jsonl [--out <new file>]` writes every card as one JSON line, sorted by id, with the fields
gbrain stamps (`registered_by`, `origin`) and, under `labels`, the card page's access labels. `gbrain storage import
--jsonl <file>` previews each line as
`create`, `identical`, `conflict` or `invalid` with a `plan_hash`; `--apply --expect <plan_hash>` registers the
missing cards with `origin: import` (gbrain stamps both fields again) and the line's labels, so a restricted card stays
restricted, never overwrites a differing card (other labels count as a difference), and skips
invalid lines without showing their values. Export leaves out a stored card that fails the card rules (a hand-edited card file, say) and names it. Export
from one brain and import into an empty one reproduces every valid card.

## Doctor

`gbrain doctor --only storage_manifest` (read-only) warns about cards that fail the current card schema, interim
records under `storage-manifest/` that are not adopted yet, and a hosted shelf whose directory is gone. It reports
not applicable on a brain with no shelf and no interim record.

## Privacy

Cards hold paths, sizes, hashes and restore forms, never file contents or credentials; the restore skill reads
credentials from its own environment. The `storage` source is not federated: ordinary search does not return cards,
and a remote connection reads them only when its grant names `storage`. Register and update run only from the trusted
local CLI, and only the storage verbs write the shelf.

Refusals and their fixes: [write refusals](write-refusals.md#storage-manifest-refusals).
