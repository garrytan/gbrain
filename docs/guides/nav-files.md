# Index, log and hot: the brain's navigation files

`foresights nav` writes three plain Markdown files you can open in any editor:

| File | What it holds |
|---|---|
| `index.md` | Every page, grouped by folder, with a one-line summary taken from the page's first sentence |
| `log.md` | What happened in the brain, newest first (imports, captures and other logged operations) |
| `hot.md` | Read this first: pages changed in the last 7 days, recent activity and files waiting in the inbox, at most 500 words |

```bash
foresights nav                     # write or refresh all three
foresights nav --dry-run           # say what would change; write nothing
foresights nav --source notes      # another source's files
foresights nav --out ~/brain-nav   # write them somewhere else
```

**Say to your agent:** *"Refresh the brain's index."* (your agent runs `foresights nav`)
**Say to your agent:** *"What's new in my brain? Read hot.md."*

## Where they go

The files go to the source's folder. When foresights manages that folder itself (a
brain created by `foresights init` keeps its pages in a managed folder under
`~/.gbrain/content/`, where only foresights's writer may change files), they go to
`~/.gbrain/nav/<source>/` instead, and the command says so. `--out` picks any
other folder. Sync skips `index.md`, `log.md` and `hot.md` at a source's root,
so they never become searchable pages themselves; a `hot.md` inside a folder
(`notes/hot.md`) is still an ordinary page.

## They are yours to edit

Each file has a marked block:

```markdown
<!-- gbrain:nav:begin. Rebuilt by `foresights nav`; write your own notes above or below this block. -->
...
<!-- gbrain:nav:end -->
```

`foresights nav` rebuilds only what is between the markers. Anything you write
above or below it stays. A file that exists without the markers is never
overwritten: the command leaves it alone and says why, so a hand-written
`index.md` is safe. Running it again with nothing new changes nothing.

## What is never named

A page is listed only when git can see its file (tracked, or new and not
ignored), or, in a folder that is not a git repository, when its file exists.
A page marked `visibility: private` is never listed. So the title of a private
or git-ignored page never lands in a file you might commit. Log entries name
only listed pages and count the rest. `foresights nav` commits nothing; commit the
files yourself if you want them in history.
