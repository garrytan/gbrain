# Store snapshot and copy verification

The primitive the shadow restore drill and `gbrain backup` of a Rust brain are to share; the drill
(`gbrain engine shadow drill --backup`, `src/shadow/drill.ts`) calls it through the owner, `gbrain backup` does not yet
(`docs/designs/RUST_ENGINE.md`, row 21b: "a Rust snapshot taken under the owner lock at one committed
generation"). Code: `snapshot.rs`, `verify.rs`, `redb_kv.rs` (`RedbSink`), `seed/follow.rs`
(`relation_digest_stream`); addon: `gbrain-napi/src/families/snapshot.rs`; owner side:
`src/core/rust-engine/store-snapshot.ts`.

## API (stable; arguments are one object with `v: 1`)

| Call | Does |
| --- | --- |
| `Brain#snapshotTo(target, { v: 1, opId })` | Copies the open brain at its latest committed generation into the new directory `target`. Resolves the manifest. |
| `Brain#snapshotCancel(opId)` | Flips the cancel flag of a running copy. Returns at once with `true` when one was running. |
| `Pool#verifyStoreDir(dir, { v: 1, expected? })` | Reads a brain directory nothing has open and resolves a report. `expected` is a manifest. |

`snapshotTo` and the owner's `snapshotStore` take two test seams, `batchDelayMs` (at most 1000) and
`batchBytes` (at least 4096). Nothing else changes what a copy holds. The owner's `snapshotStore` also takes
`maxAgeMs`, `minReserveBytes` and `pollMs`, which move the limits at which it stops a copy (below).

## The copy

One pinned read of the `Kv` (`Kv::versioned_snapshot`: the records and the commit sequence N, taken from
inside one read). The copy therefore holds exactly the commits up to N, on a single writer (redb) and on
the concurrent-writer layer alike; a commit made while it runs is in the source and not in the copy.
Keys go in key order into a new `records.redb` in 64 MiB batches without a sync; one commit at the end
writes N and syncs. While it runs, the read keeps redb's old pages, so a long copy of a busy brain grows
the source file: the owner bounds that (`src/core/rust-engine/store-snapshot.ts`). It stops a copy when the free
space of the target's or the brain's filesystem falls below its reserve or the copy runs past its age budget,
and it refuses a copy asked for while the engine disconnects (and stops one already running). Each ends
`rust_snapshot_stopped` (`disk_pressure`, `age_budget`, `cancelled`; `docs/guides/error-codes.md`). The read is
dropped as soon as the source pass ends.

**Threat model: the snapshot trusts only directories the caller's own user (or root) controls.** Before
anything is created, every directory from `/` down to the target's parent must be owned by the current
user or by root and must not be group- or world-writable (a root-owned sticky directory such as `/tmp` is
allowed above the parent); the parent itself must be owned by the current user, with no group or world
write and no sticky exception. A target that fails is refused with `invalid_argument`, naming the
directory and its owner or mode, for example `refusing snapshot: /x/y is group-writable (mode 0775);
remove group write or choose a directory you own`, and nothing is made. A copy goes to a directory you
own, such as `<shadow dir>/drills/<scratch>` under the home folder, not directly into `/tmp`. A process of
the same user that races the call (renaming directories under the target's parent while it runs) is not
defended against beyond the checks below; that is a stated limit.

`target` must not exist; `mkdir(target, 0700)` creating it is the reservation. Its parent must not be a
symbolic link, and neither the target nor the brain directory may lie inside the other. A cancel or an
error removes what the call created, and the call returns only after the read is released and the new
file is closed, so a caller that sees the return may delete its scratch space. `SnapshotOp::progress()`
reports `pinned`, false from that moment on. A cancel is checked for every entry of the source pass,
including the relation digests of a seeded store, so the read is not held for the relations that remain.

The directory is claimed once it is created: it is opened without following links, and it is refused
if it is not the empty directory just made; a directory with anything in it is left untouched. `FORMAT` and `SNAPSHOT.json` are
published through that handle, and the path is checked against it before the copy file is reopened and
after the last publish, so a path swapped mid-copy makes the call fail and nothing is written elsewhere.

The removal is anchored: on Unix the call keeps the directory it created open (`O_DIRECTORY | O_NOFOLLOW`)
and unlinks the files relative to that handle, so a path renamed or replaced by a link afterwards cannot
send a removal elsewhere. The directory entry is removed only while the path still has that directory's
device and inode. A removal that does not finish, or a path that names something else, is a `store_io`
error that names the target that remains, never a clean cancel. A platform without directory-relative
removal removes nothing and reports the target left behind. The new directory entry and the finished files are made
durable by syncing their directories; a directory that cannot be synced fails the call (a platform
that cannot open a directory skips the step).

The copy has `records.redb`, `FORMAT` and, written last after both are synced, `SNAPSHOT.json`. A
directory without `SNAPSHOT.json` is incomplete.

## The manifest

`{version, brain_id, generation, engine_format_version, schema_version, keys, bytes, tags, relations?,
created_at_us}`. `tags` maps each first key byte actually present (two hex digits, never a fixed list) to
`{keys, sha256}`; the hash covers `u64be(len key) || key || u64be(len value) || value` in key order.
`relations` appears for a seeded store: the digest of each seeded relation's digest entries, the same
bytes as `relationDigest`, streamed (`relation_digest_stream` keeps one entry in memory). Parsing is
strict: unknown fields, a different `version`, tags that are not hex or counts that do not add up are
`invalid_argument`. Numbers past 2^32 reach the addon as floats; whole floats are accepted.

## Verifying a copy

`verify_store_dir` opens the record file only through `RedbReadOnlyKv`. A normal open would upgrade an
older format, repair the member-access flag and start the keyword index builder, and each of those
commits, so a correct copy would change before anyone compared it. Verification takes no write lock, runs
no recovery and commits nothing, and refuses a file that was not closed cleanly (`store_io`).

It reads `FORMAT`, then the commit sequence, the format record, the schema version and every key in one
snapshot, and recomputes the digests. With `expected`, every field but `created_at_us` must be equal and a tag that is missing
or extra is a mismatch (`tag_missing:<hex>`, `tag_extra:<hex>`, `tag_digest:<hex>`). Without it (the copy
of a stopped store, which has no manifest) the report states what the directory holds.

The keyword index is judged by its state. Complete: the full `verify_index`. Incomplete: pages before the
cursor are checked and the cursor is reported; the unbuilt tail is not called missing, because the
builder finishes it after the copy is opened.

Verdicts: `ok`, `mismatch` (the records read and differ; codes only, never a key or value) and
`integrity` (redb refused the file, or panicked reading a damaged page). redb does not checksum stored
values on read, so a flipped value byte shows as a `tag_digest` mismatch, not as `integrity`.

## What this does not do

It does not copy an open `records.redb` (unsafe), prove the source is healthy, or restore anything: the
restore step (quarantine of jobs, sources, tokens and writers) is `gbrain backup restore`'s, and runs
after this check. A snapshot holds every page of the brain whatever any source grant says; only the
trusted local caller may ask for one.
