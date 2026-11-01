# Where your memory lives

**The short answer.** gbrain keeps your knowledge as Markdown files with YAML
frontmatter, in a folder you own and normally version in Git. Those files are
the record. gbrain indexes them into Postgres (embedded PGLite by default, or
Postgres with pgvector) with embeddings and keyword search for recall, and that
index can be rebuilt from the files at any time. What lives only in the
database, such as private pages, saved facts with no page, revision history and
write receipts, needs a database backup.

That is the paragraph to quote. The rest of this page says where each part is
and what follows from it.

## Three layers, one parent

| Layer | What it holds | Can it be rebuilt? |
|---|---|---|
| Markdown files in a source folder | Every file-backed page: frontmatter, compiled truth, timeline, and the facts and takes tables ([anatomy of a page](page-anatomy.md)). | It is the record. Git, when the folder is a repository, holds its history. |
| The index in Postgres | Pages, chunks with embeddings, the keyword (full-text) index, links, timeline rows, and facts and takes parsed from the files. | Yes, from the files: `gbrain sync`, then `gbrain extract all`. Embeddings cost a provider call again. |
| Database-only records | Pages that have no file on purpose (private pages on a strict source, `storage.db_only` folders, a brain or source with write-through off), facts saved with no page to hold them, page revision history, receipts and other operational state. | No. Back up the database. |

Recall reads the index: hybrid search ranks keyword and vector matches
together, optionally reranked, and `recall` reads saved facts. Nothing is
"just a vector store": the vectors and the keyword index both point back at
pages whose text is in the files.

## Where the folder is

A fresh `gbrain init` creates one source at
`~/.gbrain/content/<brain-id>/default` (under `GBRAIN_HOME` when it is set).
It is a plain folder until you make it a repository: `gbrain init --git`
initializes Git in a new empty folder, `--content-root <path>` picks the
folder, and `gbrain sources add <id> --path <repo>` adds a Git repository
you already have. `gbrain sources harden <id>` adds the commit-and-push hook that
keeps a remote copy current. `gbrain sources list` shows every source and its
folder. A brain initialized with `--db-only` has no folder, and the database is its
record. Connector sources (Gmail, Calendar, GitHub) render their pages into
a folder of their own.

## How tightly the database follows Git

Each source with a Git checkout runs in one of two modes:

- **Mixed (the default).** Sync imports changes made in the files. A write
  lands in the file and the database together and is committed to Git
  afterwards. When the two disagree, sync keeps a database-only change or
  holds the page for review.
- **Strict, or git-canonical (opt-in per source).** Every file-backed write is
  committed to Git before the database records it, sync indexes committed
  files only, and Git wins any disagreement; the declared database-only
  classes above are the exception. See the [git-canonical design](../designs/GIT_CANONICAL_MEMORY.md).

Either way, a page with a file can be recovered from Git. The difference is
whether the database can ever be briefly ahead of it.

## What to back up

- **The folder, through Git.** Push it somewhere you control. That covers every
  file-backed page and its history.
- **The database.** It holds the database-only records above. On PGLite that
  is `gbrain backup create --output <absolute path>`; on Postgres, your
  provider's backups or `pg_dump`. Markdown export is
  not a database backup.

The full contract, with every table classified and the disaster-recovery
commands, is the [system of record](../architecture/system-of-record.md).
[Memory boundaries](memory-boundaries.md) covers what leaves the machine and
what sharing can and can't promise.
