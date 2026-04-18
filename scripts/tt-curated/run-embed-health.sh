#!/usr/bin/env bash
set -euo pipefail
/home/tt/workspace/tools/gbrain/scripts/tt-curated/embed-safe.sh
/home/tt/workspace/tools/gbrain/scripts/tt-curated/health.sh
/home/tt/workspace/tools/gbrain/scripts/tt-curated/query-regression.py
