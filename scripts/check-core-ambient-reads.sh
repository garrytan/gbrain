#!/usr/bin/env bash
# Core ambient-read ratchet: src/core/ is an engine library a host embeds, and
# a config load, a process.env read or a module-level Map/Set ties it to one
# process and one home directory. Per-file, per-kind counts are pinned in
# scripts/core-ambient-reads.baseline.tsv and only come down. The scan is the
# TypeScript companion, scripts/check-core-ambient-reads.ts (its header has the
# rules); this wrapper is the entry verify dispatches.
#
# Usage:
#   bash scripts/check-core-ambient-reads.sh                   # compare the tree with the baseline
#   bash scripts/check-core-ambient-reads.sh --write-baseline  # rewrite the baseline after lowering a count
#
# Self-test seam: GBRAIN_GUARD_ROOT points at a fixture tree with its own
# src/core/ and scripts/core-ambient-reads.baseline.tsv; the companion reads it.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)" || exit 1

for arg in "$@"; do
  case "$arg" in
    --write-baseline) ;;
    *)
      echo "ERROR: unknown arg: $arg" >&2
      echo "usage: bash scripts/check-core-ambient-reads.sh [--write-baseline]" >&2
      exit 2
      ;;
  esac
done

exec bun "$SCRIPT_DIR/check-core-ambient-reads.ts" "$@"
