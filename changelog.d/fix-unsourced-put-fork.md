**A put that names no source no longer forks a page that lives in another source; it is refused and names the source to pass.**

### Fixed
- `gbrain put <slug>` with no `--source-id`, for a page that lives only in another source, is refused with the holding source and the exact retry (`gbrain put <slug> --source-id <source>`), with or without `--force`. Before, it wrote a second copy into `default` that an unscoped get preferred, while the original page and its file kept the old text.
- An unsourced put that goes to `default` while the only other git source is federated now prints the documented routing notice instead of staying silent.

<!-- behavior-change: put_keeps_page_source -->
