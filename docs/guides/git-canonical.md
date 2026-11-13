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
| A page write | The file and the database row are published first; a background Git effect commits and pushes the file later, once Git durability is on. The write's reply says `git_state: queued`; a receipt read later (`gbrain write-request <id>`, `get_write_request`) reads the Git effect: `committed` with the commit in `persistence.git_commit`, or `superseded`, `skipped`, `failed` or `retrying` with `persistence.git_reason`. An effect recorded by a build before this one, or one whose commit landed but whose push had to be retried, reads `committed` with no commit. | The file is written and committed under the checkout's writer lock, then the row commits. The receipt names the commit (`persistence.git_commit`, `git_state: committed`). The Git effect only pushes. |
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
| discard | Database content that Git-wins would throw away, or a page with no import record whose side the content evidence could not place (`no_record_both_moved`, `no_record_no_evidence`). The apply refuses with `git_conversion_blocked` until this is 0, and there is no override: undecided pages need a [decision](#review-list-and-decisions). |

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

### Pages with no import record: content evidence

A page whose database copy differs from its committed file and that has no
import record (it was imported before records existed) gives no record to say
which side moved. The plan decides it from content, never from a timestamp: it
compares the page's archived versions with the blobs its path held in Git
(newest first, 32 of each, following renames through the paths its versions
recorded):

| Evidence | Meaning | Category |
|---|---|---|
| `adopt_db_moved` | An older version of the page equals the committed file, and no newer state was shared: only the database moved. | adopt |
| `git_wins_file_moved` | The page equals an older committed blob of its path, and no newer state was shared: only the file moved (a plain `git commit`, for example). | git wins (`file_moved`) |
| `both_moved` | Both sides moved since the last state they shared. A revert counts as a move: a page reverted to an older state while Git edited the file is `both_moved`, not `git_wins_file_moved`. | discard until decided |
| `no_evidence` | Nothing shared within the depth (no archived version, a path with one blob, a segmented page whose export matches no blob or that has any archived version, which cannot be compared by content), or the other side's history reached the depth or lost versions to pruning (basis `history_truncated`). | discard until decided |

A later `updated_at` on the database row changes nothing here. The evidence
kind of each page is part of the preview hash, and `gbrain sources git-gap
<source-id> --json` reports the same split as `direction_evidence`.

### Review list and decisions

The undecided pages go on a review list:

```bash
gbrain sources canonical <source-id> --to git --dry-run --list-out ~/review.json
```

The file lists each page with its slug, path, revision, committed blob, evidence
and `decision: null`, newest first. Fill in `decision` (`adopt` or `git_wins`)
for the pages you decide, then preview with the file:

```bash
gbrain sources canonical <source-id> --to git --dry-run --decisions ~/review.json
gbrain sources canonical <source-id> --to git --apply --expect <hash> --decisions ~/review.json
```

A decision names the page at its revision, blob and evidence: once the page
moves again it is counted `stale` and not applied, and the page waits for a new
decision. The file is bound into the preview hash. Review lists, decision files
and approvals hold page names, so gbrain writes them owner-only (mode 0600) and
refuses any path inside a source's checkout or the Git working tree that holds
it, including a symlink into one (`conversion_file_in_source_root`).

### Approval across time

A preview hash is bound to HEAD, so a commit between review and apply refuses
the whole apply. When the owner approves a large plan, write the approval
instead and apply it later:

```bash
gbrain sources canonical <source-id> --to git --dry-run [--decisions <file>] --approval-out ~/approval.json
gbrain sources canonical <source-id> --to git --apply --approved ~/approval.json
```

The approval records the categories and each item's page, revision, blob and
evidence. The apply plans again and compares every item with the approved one.
With no difference it converts as `--expect` would. Otherwise it commits only the
adoptions and withholds that are unchanged since the approval, leaves the source
mixed, and exits 1 with `git_conversion_delta`: the list of changed, new and
undecided items with counts, for the owner to decide before a new approval.

### When an apply stops

A failed apply reports where it stopped (`recovery` in `--json`): the mode it
reached (`mixed` or `git`), the door commits it made (each group's sha), their
push state and the writes it made. Pages that changed during the apply are held
instead of overwritten (`changed_since_preview`), so a page written between
the preview's recheck and the strict pass keeps its database version. Nothing is
rewritten on the way back: a source left strict is re-derived with
`gbrain sources reindex <source-id> --from-git` and returned with `--to mixed`;
the adopted pages keep the content they had, because their committed files
hold the database's own bytes.

**A new, empty source** can start strict instead:
`gbrain sources host-repo <id> --dir <path> [--push-remote <url>]` previews a bare
repository people clone, with a worktree gbrain owns; running the printed
command with `--expect <plan_hash>` creates them and makes the source strict. See [hosted repositories](multi-source-brains.md#hosted-repositories).

## How writes reach a strict source

Every write goes through the same door, whoever sends it:

- **Local writers** (`put_page`, `capture`, `remember`, imports, dream,
  connectors, maintenance) publish through the managed writer, which commits
  before the row. A fact with no entity, or for an entity that has no page yet,
  from any of them (`remember`, fact extraction, Google loops, an owner
  releasing a quarantined fact) is committed as a row of `memory/unattributed`;
  a row for an entity names it in the `entity` column and moves into the
  entity's page once that page exists, including a name saved without a
  folder (`kofi-example`) once exactly one page such as
  `people/kofi-example` carries it. An entity under a folder access rule is
  held on its own folder's holding page instead (`partners/memory/unattributed`
  for `partners/acme-example`), which every rule covering the entity covers by
  path, so the row has exactly the readers the entity's page would have and is
  stored like it (in Git, or database-only under `storage.db_only` or a path
  Git ignores). A rule added later moves the held rows it covers there as part
  of its own apply (`gbrain access rule add` previews them as
  `held_facts_moving`; `gbrain access apply` and `gbrain access resume` move
  them too). A rule that arrives through a sync of the policy file moves them
  as soon as that sync releases its lease (an exact page rule on an entity
  held on its folder's page moves that row into the entity's page the same
  way), so for the seconds the sync pass takes the row is still in the holding
  page's body (its fact already reads only for the rule's readers); if the
  process stops in between, the next maintenance cycle moves them. The move
  also removes those rows, and the struck (withdrawn) rows of the same
  entities, from the holding page it leaves and from that page's saved
  versions in the database (the rule's preview counts them per page, and the
  move's write receipt records which rows, how many versions and where they
  went). A saved version stored in segments (a holding page over 1 MiB with
  `pages.segmented_storage` on) is not edited: the preview names how many
  there are (`segmented_versions_not_edited`), the apply's result says it is
  incomplete (`complete: false`), and readers of that page's saved versions
  can still read the moved rows in up to that many versions. A move still
  pending when the apply stops waiting is reported incomplete the same way,
  with its request id, and is not counted as moved. The preview lists every
  held fact the apply moves, with its destination as the move resolves it, so
  a row saved under a bare name shows the page that name resolves to, and a
  row that moves only because its entity's page now exists says so
  (`because`). Git history is never rewritten: the holding page's earlier
  commits keep the row as it was before the rule. An entity under an exact page rule (a rule on the
  entity's own slug) has no holding page with its readers: the fact is refused
  with [`git_home_required`](write-refusals.md#git_home_required) (reason
  `facts_lane`) until the page exists.
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
| Facts held for an entity under a folder that is database-only | Held on that folder's holding page, which is database-only like the entity's own page would be. |

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

## Rebuilding a strict source's database from a clone

A strict source's Git history holds every page outside the database-only
classes above, so a lost or damaged database can be rebuilt from a clean clone.
Don't sync the clone into a source that is already marked `canonical: git` on
a brain without managed persistence: every file is refused with
`strict_requires_managed`, nothing is imported, and the sync stops with that
code. The files are fine, so don't use `--skip-failed` for it; that would move
the checkpoint past content the database never received.

Index the clone as a mixed source first, then convert it:

```bash
gbrain init --pglite --no-embedding                         # a new, empty brain
gbrain sources add <source-id> --path <clone>               # the clean clone, as a mixed source
gbrain sync --source <source-id> --no-pull --no-embed       # index every committed page
gbrain sources canonical <source-id> --to git               # preview: prints the plan and its hash
gbrain sources canonical <source-id> --to git --apply --expect <hash>
gbrain sources reindex <source-id> --from-git               # preview the re-derive from Git
gbrain sources reindex <source-id> --from-git --apply --expect <hash>
```

Facts that were held on `memory/unattributed` or on a folder's holding page
(`<folder>/memory/unattributed`) come back from its file with the entity they
were saved for. Back up the database as well: Git does not hold the
database-only classes, the write receipts or the other operational records.

## What doctor and status show

| Where | What it tells you |
|---|---|
| `gbrain doctor` → `git_index_lag` | Per strict source, how many commits and seconds the index trails HEAD. It warns once the oldest unindexed commit is older than 900 s (`GBRAIN_DOCTOR_GIT_INDEX_LAG_WARN_SECONDS`), and its fix is `gbrain sync --source <id> --no-pull`. Until then, search and reads show the older version. |
| `gbrain doctor` → `strict_facts_outside_git` | Per strict source, the facts with no Git home, the facts held on a holding page for more than 30 days, and held facts that cannot move (with the reason, or the candidate pages of a bare name). It warns when any is non-zero, and its fix is the read-only preview of [`gbrain repair facts-home`](repair.md#facts-home). A source that is not strict is not judged. |
| `gbrain doctor` → `db_ahead_of_git` | The git-gap totals for every source with a checkout, strict or not, with each source's live pages (a scan the budget stopped reads `PARTIAL, <read> of <live> live page(s) read`). Informational: always ok. Bounded by `GBRAIN_DOCTOR_GIT_GAP_TIMEOUT_MS` (10 s by default). |
| `gbrain sources git-gap <id> [--sample n] [--json]` | Each page's state against HEAD: `equal`, `database_ahead`, `git_ahead`, declared or undeclared database-only, `worktree_only`, `unparseable`, `unsafe_path`, with a sample of paths, the source's `live_pages`, and `direction_evidence` for differing pages with no import record. Read-only. |
| `gbrain sources reindex <id> --from-git` | A preview of every database version Git would replace, bound to HEAD by a hash; `--apply --expect <hash>` runs that pass. Use it to re-derive a strict source's index on purpose. |
| `gbrain sync status --source <id> --json` | The sync pass that indexes commits: state, reason and the last error. |
| A write receipt | `persistence.git_commit` and `git_state: committed`. A door commit that landed before its row, on a write that then ended without committing, keeps `landed_before_row: true`: Git holds those bytes and the indexer imports them. |

Explain any code offline with `gbrain errors <code>`. The ones specific to
strict sources are `strict_requires_managed`, `git_home_required`,
`git_private_commit_refused`, `git_lfs_not_enabled`, `git_protocol_required`,
`git_detached_head`, `git_branch_unborn`, `git_conversion_blocked`,
`git_conversion_delta`, `conversion_file_in_source_root` and
`git_conversion_incomplete`.
