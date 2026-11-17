---
kind: add
---
New command gbrain nav writes three Markdown files: index.md lists every page by folder with a one-line summary, log.md lists recent operations newest first, and hot.md is a short what-is-new page (the last 7 days, at most 500 words) to read at the start of a session. Only the block between the gbrain:nav markers is rebuilt, so notes you write above or below it stay, and a file without the markers is never overwritten. Private and git-ignored pages are never named. The files go to the source's folder, or to ~/.gbrain/nav/<source>/ when gbrain manages that folder. Sync now skips a hot.md at a source's root, as it already skips index.md and log.md; a hot.md inside a folder is still a page. If you kept a page in a root hot.md, move it into a folder or rename it.
