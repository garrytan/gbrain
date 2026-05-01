#!/usr/bin/env bash
# scripts/profile-tests.sh
# Tier 4 helper: prints the top N slowest unit tests from a previous run.
# Pipe a captured `bun test` output (or a ci:local log) into stdin; we extract
# `(pass|fail) ... [Xms|Xs]` lines, convert to ms, sort descending.
#
# Usage:
#   bun test --timeout=60000 2>&1 | bash scripts/profile-tests.sh
#   bash scripts/profile-tests.sh < /path/to/captured.log
#   bash scripts/profile-tests.sh -n 20 < /path/to/captured.log
#
# To demote a test as slow: rename its file to *.slow.test.ts. The file
# stays discoverable by `bun test` (CI runs everything via `bun run test`)
# but is excluded from `bun run ci:local`'s fast unit shard fan-out.

set -euo pipefail

TOP_N=10
if [ "${1:-}" = "-n" ] && [ -n "${2:-}" ]; then
  TOP_N=$2
fi

# Lines look like: (pass) describe > test name [12345.67ms] OR [12.34s]
# Single awk pass for performance (input can be tens of MB).
awk '{
  # Find the LAST bracket in the line: [<num><unit>] where unit is ms or s.
  for (i = length($0); i > 0; i--) {
    if (substr($0, i, 1) == "]") {
      # Walk back to matching "["
      j = i - 1
      while (j > 0 && substr($0, j, 1) != "[") j--
      if (j == 0) break
      bracket = substr($0, j+1, i-j-1)
      # bracket should match ^[0-9]+(\.[0-9]+)?(ms|s)$
      if (bracket ~ /^[0-9]+(\.[0-9]+)?(ms|s)$/) {
        if (bracket ~ /ms$/) {
          n = substr(bracket, 1, length(bracket) - 2) + 0
        } else {
          n = (substr(bracket, 1, length(bracket) - 1) + 0) * 1000
        }
        if (n > 0) printf "%.0f\t%s\n", n, $0
      }
      break
    }
  }
}' | sort -rn | head -n "$TOP_N" | awk -F'\t' '{ printf "%8.0fms  %s\n", $1, $2 }'
