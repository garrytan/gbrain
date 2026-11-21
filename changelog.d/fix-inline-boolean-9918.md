---
important: data-loss
---
**`gbrain delete <slug> --purge=0` no longer hard-deletes: an inline boolean flag such as `--purge=0`, `--include-deleted=no` or `--dry-run=off` is refused instead of being read as on.**

### Fixed
- An inline `--flag=<value>` for a boolean flag on a gbrain command, including `--json` and `--dry-run`, now takes only `true` or `false`, the same as the space-separated form. Any other value is refused with `invalid_params` (exit 2), names the flag and runs nothing. Before, every value other than `false` turned the flag on, so `delete --purge=0` ran the irreversible hard delete and `get --include-deleted=0` showed a soft-deleted page. Spellings such as `--json=1` or `--dry-run=yes` that used to read as on now refuse too; write the flag on its own instead (#9918, reported by @Masashi-Ono0611).

<!-- behavior-change: cli_inline_boolean_strict_9918 -->
