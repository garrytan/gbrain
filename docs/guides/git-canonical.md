# Git-canonical sources (strict mode)

A source in git-canonical mode, also called strict mode, keeps its pages in Git
first. Every page write is committed to the source's checkout before the
database records it, and the database is an index that gbrain can rebuild from
the commits. When Git and the database disagree, Git wins.

Strict mode is chosen per source and is **off by default**. Nothing turns it on
during an upgrade: a source becomes strict only when you convert it with
`gbrain sources canonical` or host a new source with `gbrain sources host-repo`.
The design, with the full reasoning and every edge case, is
[GIT_CANONICAL_MEMORY.md](../designs/GIT_CANONICAL_MEMORY.md). This page is the
operator's view.

## What changes for a strict source

| | A mixed source (the default) | A strict source (`canonical: git`) |
|---|---|---|
| A page write | The file and the database row are published first; a background Git effect commits and pushes the file later, once Git durability is on. | The file is written and committed under the checkout's writer lock, then the row commits. The receipt names the commit (`persistence.git_commit`, `git_state: committed`). The Git effect only pushes. |
| A crash between the two | Recovery restores the file's previous bytes. | The committed file is kept, and the write's replay finishes the row against it. |
| What sync reads | The working tree and the database; disagreements become holds such as `file_drift` or `worktree_dirty`. | Committed blobs at HEAD only. Each committed version is imported over what the database holds, and a committed removal deletes the page. |
| An uncommitted edit in the checkout | Held as `worktree_dirty`. | Left on disk and not indexed until someone commits it. |
| `gbrain sync --working-tree` | Reads the working tree. | Refused with `managed_sync_flag_refused`. |
| A row write from an older gbrain that does not know the mode | Accepted. | Refused by the database guard (`git_protocol_required`). |

Writes to a strict source pay for a local commit. The door commits with Git
plumbing and updates the index only for the paths it wrote, so on a
150,000-file checkout it adds about 230 ms per write (p50). Writes published
as one group share a commit (a `put_pages` batch publishes up to 8 pages per
group, and maintenance writers group their pages per run), so a large batch
makes several commits. Independent writes each make their own.

## When to turn it on

Turn it on for a source when you want its Markdown in Git to be the record:
people and other clones read, review and edit the files, and you want to be
able to rebuild the index from them. It also removes the class of problems
where the database and the checkout drift apart on a busy source (drift holds,
held deletions, parked per-write commits), because the database is never ahead
of Git.

It needs:

- **Managed persistence on the brain.** Only the managed writer commits through
  the door. On an unmanaged brain, conversion and every direct import into a
  strict source are refused with `strict_requires_managed`. Turning managed
  persistence on is its own step (`gbrain sources writer activate`); see
  [local registrations and canonical ownership](concurrent-writes.md#local-registrations-and-canonical-ownership).
- **A Git checkout for the source, on a branch.** A source with no checkout
  stays database-only as a whole and can't be strict. A strict write on a
  detached HEAD or an unborn branch is refused (`git_detached_head`,
  `git_branch_unborn`) and rolls back.
- **The trusted local CLI on the brain host.** `sources canonical` and
  `sources host-repo` are not MCP operations, and an agent runs either on a
  production brain only with the user's yes, one source at a time.

Leave a source mixed when it has no checkout, when you don't want a local
commit on the write path, or while other writers on the host still run a gbrain
older than the one that converted it.

## Converting an existing source

Look first. Both commands below are read-only:

```bash
gbrain sources git-gap <source-id> --json          # how far the database is from HEAD, page by page
gbrain sources canonical <source-id> --to git      # the conversion plan (--dry-run is the default)
```

The plan puts every live page in one category and prints a preview hash:

| Category | What the apply does |
|---|---|
| adopt | The database holds content Git lacks (`database_ahead`, `undeclared_database_only`, `worktree_only`). The page is written to its file and committed through the door, up to 200 pages per commit. No row changes. |
| declared | The page belongs to a [database-only class](#what-stays-in-the-database-only). Nothing is written. |
| git wins | Git moved and the database did not (or the hold already matches the committed file). The strict pass indexes the committed file. |
| holds | Open sync holds are cleared so Git's verdict runs over them. |
| parked effects | Retried once, or recorded as declared when Git ignores the target. |
| discard | Database content that Git-wins would throw away. The apply refuses with `git_conversion_blocked` until this is 0, and there is no override. |

When the plan is what you expect, apply exactly that plan:

```bash
gbrain sources canonical <source-id> --to git --apply --expect <hash> [--no-embed] [--no-extract]
```

A plan that changed since the preview refuses with `preview_changed`; preview
again. The apply adopts group by group (a crash leaves the source mixed, and the
next preview lists only what is left), runs a full strict pass, sets
`canonical: git`, then runs one more strict pass. A pass that stops early, or
writes that land during the conversion, end it with
`git_conversion_incomplete`: the source stays mixed if the first pass stopped
before the flag was set, and strict (Git wins) if it stopped after. Wait until
`gbrain sync status --source <id> --json` shows it idle, preview again and apply
the new hash.

**A new, empty source** can start strict instead:
`gbrain sources host-repo <id> --dir <path> [--push-remote <url>]` previews a bare
repository people clone, with a worktree gbrain owns; running the printed
command with `--expect <plan_hash>` creates them and makes the source strict. See [hosted repositories](multi-source-brains.md#hosted-repositories).

## How writes reach a strict source

Every write goes through the same door, whoever sends it:

- **Local writers** (`put_page`, `capture`, `remember`, imports, dream,
  connectors, maintenance) publish through the managed writer, which commits
  before the row.
- **Remote MCP callers and thin clients** send a write request that the
  checkout owner's door commits. The reply carries the revision once it is
  committed and indexed, or `write_pending` with a request id (exit 10 on the
  CLI) while the owner is busy or offline. Poll it with
  `gbrain write-request <id>`; it is never "failed" or "not found". The owner
  re-checks the caller's grant before committing, so a grant revoked while the
  request waits is refused with no commit and no row.
- **Scripts, crons and people** that write files commit them, for example with
  `gbrain git commit-push -m "<msg>" -- <paths>`
  ([shared checkout rules](shared-checkout-git.md#scripts-and-the-managed-checkout)).
  The next sync pass indexes the commit. An edit nobody commits is never
  indexed.

Pushing is off the write path. A push conflict on a page path parks only the
push; local commits and writes keep going.

## What stays in the database only

Some content has no file on purpose. On a strict source each of these is a
declared class, and anything else that would land in the database without a
file is refused with [`git_home_required`](write-refusals.md#git_home_required).

| Class | What happens |
|---|---|
| Private, alias-private and lineage-private pages | Never committed. A page turning private is published as the door commit that removes its file; turning world again writes the file back at the path it had. Commits made before it turned private still hold the old text, and gbrain never rewrites history. A write that would commit private bytes is refused with [`git_private_commit_refused`](write-refusals.md#git_private_commit_refused). |
| Pages under a `storage.db_only` directory in `gbrain.yml` | The door never commits under them ([storage tiering](../storage-tiering.md)). |
| Derive-phase pages that never had a file | Kept database-only. |
| Paths the checkout's Git ignores | Never committed and never given a Git effect. |
| Detached pages and origin twins | Kept database-only. |
| Derived data: chunks, embeddings, links and rows parsed from pages | Rebuilt from Git, never content of record. |
| Write receipts and other operational records | Kept in the database as metadata; Git commits don't carry them. |

A file under a Git LFS rule is refused with `git_lfs_not_enabled` unless
`storage.git_lfs` is on and the checkout configures the LFS filter; the door
then commits the LFS pointer.

Git holds every page outside these classes, so a strict source's index can be
rebuilt from it. Back up the database too: it holds the declared classes,
receipts and other operational records.

## Turning it off

```bash
gbrain sources canonical <source-id> --to mixed                          # preview
gbrain sources canonical <source-id> --to mixed --apply --expect <hash>
```

This removes `canonical: git` and changes nothing else. Git keeps every door
commit and no row is rewritten; the source goes back to mixed behavior on its
next write and sync pass.

## What doctor and status show

| Where | What it tells you |
|---|---|
| `gbrain doctor` → `git_index_lag` | Per strict source, how many commits and seconds the index trails HEAD. It warns once the oldest unindexed commit is older than 900 s (`GBRAIN_DOCTOR_GIT_INDEX_LAG_WARN_SECONDS`), and its fix is `gbrain sync --source <id> --no-pull`. Until then, search and reads show the older version. |
| `gbrain doctor` → `db_ahead_of_git` | The git-gap totals for every source with a checkout, strict or not. Informational: always ok. Bounded by `GBRAIN_DOCTOR_GIT_GAP_TIMEOUT_MS` (10 s by default). |
| `gbrain sources git-gap <id> [--sample n] [--json]` | Each page's state against HEAD: `equal`, `database_ahead`, `git_ahead`, declared or undeclared database-only, `worktree_only`, `unparseable`, `unsafe_path`, with a sample of paths. Read-only. |
| `gbrain sources reindex <id> --from-git` | A preview of every database version Git would replace, bound to HEAD by a hash; `--apply --expect <hash>` runs that pass. Use it to re-derive a strict source's index on purpose. |
| `gbrain sync status --source <id> --json` | The sync pass that indexes commits: state, reason and the last error. |
| A write receipt | `persistence.git_commit` and `git_state: committed`. A door commit that landed before its row, on a write that then ended without committing, keeps `landed_before_row: true`: Git holds those bytes and the indexer imports them. |

Explain any code offline with `gbrain errors <code>`. The ones specific to
strict sources are `strict_requires_managed`, `git_home_required`,
`git_private_commit_refused`, `git_lfs_not_enabled`, `git_protocol_required`,
`git_detached_head`, `git_branch_unborn`, `git_conversion_blocked` and
`git_conversion_incomplete`.
