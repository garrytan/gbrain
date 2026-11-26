**`llms-full.txt` has room to grow again: it is about 140 KB under its 800 KB size budget instead of 2 bytes.**

### Changed
- `llms-full.txt` no longer inlines `docs/guides/live-sync.md` or `docs/protocol/MEMORY_VERBS_v1.md`. Both stay linked from `llms.txt`, from `AGENTS.md` and from `CLAUDE.md`, and `gbrain protocol --json` still prints the memory-verb contract. The single-fetch bundle drops from 799,998 to 658,903 bytes, so doc edits stop failing the size check.
