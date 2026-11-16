**Every pull request is now checked against stable's promise: removing a command, flag, MCP tool or parameter, config key or exit code needs a deprecation record whose 14-day notice has passed.**

### Added
- `bun run check:public-surface`, part of `bun run verify`. It compares this tree with the merge base against `docs/contracts/public-surface.json`, a list built from the code by `scripts/build-public-surface.ts` (refreshed by `bun run regen:all`). It refuses a pull request that drops a listed entry, or changes an exit code, before a `deprecations.d/<id>.md` record for it has reached its `remove_after` date. A `cli-command` or `mcp-tool` record also covers that command's flags or that tool's parameters.
- Removals the promise does not cover go through with no record. That means anything missing from the list at the current stable release (the `stable` tag), and any removal in a pull request that adds a `kind: breaking` row with `exception: security` or `exception: data-loss`. Until a stable release carries the list, or when the tag can't be read, the check says so and counts everything as on stable; a revert then adds a row with `exception: revert` that names the pull request it reverts.
- New deprecation records must give at least 14 days of notice, and an announced `remove_after` date can move later but never earlier.
- New `behavior-changes.d` rows need `kind:` front matter (`breaking`, `action`, `default`, `fix` or `add`). A `breaking` row needs an exception or a `deprecation: <id>` naming a record whose date has passed.
- A change to the CLI or agent-contract goldens needs a new behaviour-change row, or a `<!-- public-surface: no-behavior-change: <reason> -->` line in the changelog fragment.

### For contributors
- `docs/STABILITY.md` "How it is checked" says what the check enforces and what still rests on review: `--json` fields, the page format, wording, behaviour beyond names, the two-stable-releases rule, and the flags of the 124 CLI-only commands without a curated help record.
- A branch converted with `bun run release:unstamp` gets rows without `kind:`; add one to each before pushing (docs/RELEASING.md).
