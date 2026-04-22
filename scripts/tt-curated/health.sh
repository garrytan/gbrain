#!/usr/bin/env bash
set -euo pipefail
source /home/tt/workspace/tools/gbrain/scripts/tt-curated/common.sh

run_gbrain doctor --json
run_gbrain features --json
run_gbrain stats
