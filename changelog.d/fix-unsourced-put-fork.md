**A put that names no source no longer forks a page that lives in another source; it is refused and names the source to pass. This holds for `put-pages` and uploads too, and a put run inside a source's checkout counts as naming that source.**

### Fixed
- `gbrain put <slug>` with no `--source-id`, for a page that lives only in another source, is refused with the holding source and the exact retry (`gbrain put <slug> --source-id <source>`), with or without `--force`; `put-pages` refuses such a page in its receipt while writing the others, and uploads refuse a new page the same way. A put run from inside a source's checkout writes to that source and is not refused. Before, it wrote a second copy into `default` that an unscoped get preferred, while the original page and its file kept the old text.
- An unsourced put that goes to `default` while the only other git source is federated now prints the documented routing notice instead of staying silent (`--quiet` silences it).

<!-- behavior-change: put_keeps_page_source -->
