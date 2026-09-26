#!/usr/bin/env bash
# Known-good shell form; a comment that says `bun build --compile` builds a binary is prose.
bun build --compile --no-compile-autoload-bunfig --outfile "$OUT_BIN" scripts/smoketest.ts
