# Plain-directory sources

Index a local folder of Markdown notes without creating a Git repository. The
folder remains the source of truth, and GBrain preserves imported filenames when
writing a note back to it. Use this for an existing notes folder whose files are
managed by another application.

**Say to your agent:** *"Add my notes folder as a directory source, exclude its
private application settings, and check that a sync completed successfully."*

```sh
gbrain sources add notes --kind directory --path /absolute/path/to/notes \
  --exclude '.obsidian/**'
gbrain sync --source notes
```

To convert an already registered source, keep its existing ID and path:

```sh
gbrain sources set-kind notes directory --exclude '.obsidian/**'
```

Directory sources do not pull, commit, or push Git changes. Sync records a
checkpoint only for files successfully imported or confirmed unchanged. An
ordinary file error is reported as a failed file; cancellation is reported as
cancellation. Neither silently advances the checkpoint past failed work.

Writes use the recorded source path for existing notes. For new notes, GBrain
can resolve a slug's parent folders to existing human-readable folder names.
The final Markdown filename remains the slug's filename. Excluded paths and
paths outside the source root are refused. Existing source grants and writer
ownership requirements still apply; registering a folder does not grant a
remote client new permissions or activate managed writing.

For a client restricted to a note prefix, `put_page` adds that prefix when the
provided slug does not already include an allowed prefix. Subagent writes keep
their explicit slug requirements. The resulting slug still passes the normal
source and permission checks.

Embedding work runs after the sync import by default. Use `--inline-embed` when
the caller needs to wait for embeddings. A completed import and completed
embedding work are separate outcomes. Existing provider and spending policies
continue to apply.

Read [concurrent writes](concurrent-writes.md) before changing an existing
source's writer ownership or activation.
