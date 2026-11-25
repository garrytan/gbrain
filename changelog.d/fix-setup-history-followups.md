**The commands `gbrain setup` prints for the history import now keep the choices you gave setup, so running one later wires things the same way.**

### Fixed
- The accept, decline, resume and deferred commands setup prints for the history import now carry this run's wiring choices (`--no-hooks`, capture, providers, instructions, `--surface` and `--advertise`, skill loading, `--workspace`, `--gbrain-bin`, a pinned `--source` and `--no-stdio-member`), and quote paths that contain spaces. Before, running one of them quietly undid those choices. The command printed while a running server holds the brain also keeps `--history-dir` and `--no-extract`.
- Each history import step that setup starts now runs against the brain setup created on this machine, never a project's brain that the current folder points at.
- A newest session with nothing to archive now reports `nothing_found` instead of `imported`, so setup offers it again later.
