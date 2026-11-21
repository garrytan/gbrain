---
important: data-loss
---
**CLI boolean values now refuse ambiguous input instead of enabling destructive flags.**

### Fixed
- Refuse explicit operation boolean values other than `true` and `false`, including `delete --purge=0`, and apply the same validation to operation `--json` and `--dry-run` values. Bare flags and explicit `true`/`false` remain supported (#9918).

<!-- behavior-change: cli_strict_boolean_values_9918 -->
