#!/bin/bash
# The schema generator chain lives in scripts/build-schema.ts (refactor wave 1, W2).
exec bun "$(dirname "$0")/build-schema.ts" "$@"
