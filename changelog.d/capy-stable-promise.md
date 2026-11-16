**docs/STABILITY.md now says what stays the same on the stable channel, and how much warning you get before something changes.**

### Added
- A "What stays the same on stable" section in docs/STABILITY.md. It covers command names and their documented flags, MCP tools and their parameters, documented config keys, the page and frontmatter format, exit codes and the top-level `--json` fields of documented commands, and upgrades from any stable release of the last six months. A removal or rename is announced in a stable release first, keeps working with a warning, and is removed no sooner than 14 days and two stable releases later. Security and data-loss fixes are the one exception. The section also lists what the promise does not cover, including very large brains during an upgrade until #9192 is fixed.
- `deprecations.d/README.md`, which says how a planned removal is recorded and announced before it happens.
- The README's Stability section points to the new promise.
