**`gbrain value` shows what your brain holds and has done for you, as real counts.**

### Added
- `gbrain value` prints one card with conversations archived and the days they cover, pages by kind, links, facts kept (active, superseded, withdrawn), lookups served, pages brought up on their own and how many were later retrieved, nightly items and the brain score. Every row is a measured number, `off` with the command that turns it on, or `unavailable` with a code and the reason; a row never shows 0 for a number that could not be read. `gbrain value --json` prints the same card as a versioned JSON document (`gbrain.value`, version 1). On a brain with no embedding key the score reads "N of N reachable without a key".
- The card is a local command on the computer that holds the brain. It is not an MCP tool on any surface, and a thin client refuses it. If every count fails to read, it exits non-zero with the error `value_unavailable`.

### Fixed
- A recall answered without a ranked search (facts only, or keyword search on a keyless brain) and a keyword-only `search` now count as lookups in search telemetry, so lookup totals no longer miss them on the default keyless install. Lookups served also counts searches gbrain runs for itself, such as the nightly cycle.

<!-- behavior-change: value_card_cli -->
